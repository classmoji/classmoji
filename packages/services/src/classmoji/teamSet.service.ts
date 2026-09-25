/**
 * Team sets — configure a grouping of a CLASSROOM form's respondents, solve it,
 * and (only on an owner's explicit confirm) turn one solution into real teams.
 *
 * Three nouns, and the line between them is the point of this file:
 *
 *   - A SET is one configured grouping for one form ("workshop-pairs"). Its
 *     config is a TeamSetConfig (teamSetConfig.ts); it becomes a Tag on create.
 *   - A RUN is one solve of that config against the form's responses AS THEY
 *     STOOD when it started. It is a PROPOSAL. It stores ids and integers only
 *     (the compiled TeamSetProblem, the TeamSetContext, a staleness snapshot)
 *     and it never touches a Team row. The solve itself happens in the
 *     `team-set-solve` Trigger task, which calls back into `completeRun`.
 *   - CREATE turns one SOLVED, non-stale run into Teams under the set's tag.
 *     It is claimed atomically (`claimCreate`) and executed by the
 *     `team-set-apply` task (`applyCreate`). It only ever ADDS: a Team delete
 *     cascades to its repositories and their grades, so no path here issues one.
 *
 * ── Authorization ───────────────────────────────────────────────────────────
 * None, by the same documented design as form.service / formResponse.service:
 * every caller (the MCP tools, later the pages routes) runs its own role and
 * Pro gates first. What this file DOES own is SCOPING — every entry point that
 * a caller reaches takes `classroomId` and resolves its target through it, so a
 * form, set or run id from another classroom is `not_found`, never a read.
 * The functions only the Trigger tasks call (`loadRunForSolve`, `markRunning`,
 * `completeRun`, `failRun`, `applyCreate`, `stopCreate`) take bare ids: their
 * payload was written by this file after the caller was scoped.
 *
 * ── Nothing is left hanging ─────────────────────────────────────────────────
 * There is no sweeper job. A run QUEUED/RUNNING, or a create RUNNING, far past
 * its task's lifetime is expired (FAILED 'lost') the next time anything reads
 * it; a FAILED create can be claimed again (same run: the teams it made are
 * skipped; no team made: any run).
 *
 * ── Who is in the set ───────────────────────────────────────────────────────
 * The ROSTER is the classroom's STUDENT memberships, with no accepted-invite
 * filter — deliberately the same set `form.service.materializeSourcedOptions`
 * freezes into a `roster_select`, so every user id a respondent can pick is a
 * person the solver knows about. RESPONSES are SUBMITTED rows with a user id
 * (one per user by the partial unique index), INTERSECTED with that roster: a
 * staff member who test-filled the form, or a student who has since dropped,
 * must not be put on a GitHub team.
 *
 * ── Staleness ───────────────────────────────────────────────────────────────
 * A run snapshots `{ revision_id, responses: [{id, user_id, updated_at,
 * answers_hash}], roster_user_ids }`. It is stale when the form was
 * republished, a response's ANSWERS changed, a response appeared or went away,
 * or (non_respondents = 'include') the roster changed. The hash is compared
 * rather than `updated_at` alone because staff triage (`updateStaff`:
 * staff_status / staff_note) bumps `updated_at` without changing a single
 * answer, and a triage label must not invalidate a solve.
 *
 * ── Errors ──────────────────────────────────────────────────────────────────
 * `TeamSetError.code` is a closed vocabulary callers branch on; the message is
 * for humans. A run's `error` column is a second closed vocabulary
 * (TEAM_SET_RUN_ERRORS) — never exception text, which would carry Prisma query
 * text or provider internals to a client.
 */
import { createHash } from 'node:crypto';

import { tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import { Prisma } from '@prisma/client';
import type {
  TeamSet as TeamSetDbRow,
  TeamSetRun as TeamSetRunDbRow,
  TeamSetRunStatus,
} from '@prisma/client';

import { getGitProvider } from '../git/index.ts';
import { flattenFields, type FormField } from './formContract.ts';
import { fieldsOf } from './form.service.ts';
import * as organizationTagService from './organizationTag.service.ts';
import * as teamAdminService from './teamAdmin.service.ts';
import { TeamServiceError, isReservedSlug, predictTeamSlug } from './teamAdmin.service.ts';
import { sleep } from './sleep.ts';
import {
  TeamSetConfigSchema,
  TeamSetConfigError,
  applyConfigPatchWithNotes,
  suggestConfig,
  validateConfigAgainstForm,
  type TeamSetConfig,
  type TeamSetConfigPatchInput,
} from './teamSetConfig.ts';
import {
  compileProblem,
  type CompileInput,
  type TeamSetContext,
  type TeamSetProblem,
} from './teamSetProblem.ts';
import { scoreAssignment } from './teamSetScore.ts';
import { runChecks, type CheckIssue } from './teamSetChecks.ts';
import { computeMetrics, type PersonPlacement, type TeamSetMetrics } from './teamSetMetrics.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Task ids, named by string for the reason deckThumbnail.service documents:
 * `@classmoji/tasks` depends on this package, so importing the task objects
 * would close a cycle. A renamed task fails at runtime, so the ids live here,
 * once.
 */
const SOLVE_TASK_ID = 'team-set-solve';
const APPLY_TASK_ID = 'team-set-apply';

/**
 * What `engine` records when a run is queued. Must match
 * packages/tasks/python/requirements.txt. `completeRun` replaces it with the
 * version the engine itself reports (`SolverOutput.engine`), when it does.
 */
export const TEAM_SET_ENGINE = 'cpsat@9.15.6755';

/** Seeds and run numbers are stored in INT4 columns. */
const MAX_SEED = 2 ** 31 - 1;
const MAX_RUN_NUMBER = 2 ** 31 - 1;

/**
 * Lazy expiry, instead of a sweeper job. A run or a create whose background
 * task died without writing its ending would otherwise say QUEUED / RUNNING
 * forever, and a RUNNING create blocks every retry. Each is expired the next
 * time anything reads it, well past the task's own maxDuration: the solve task
 * is capped at 300 s, the apply task at 1,800 s. A QUEUED run gets longer
 * because a burst of runs legitimately waits in the solve queue.
 */
const RUN_QUEUED_TTL_MS = 15 * 60_000;
const RUN_RUNNING_TTL_MS = 10 * 60_000;
const CREATE_RUNNING_TTL_MS = 35 * 60_000;

/** How often `waitForRun` re-reads a run's status. */
const DEFAULT_POLL_MS = 300;

/**
 * previewCreate asks GitHub whether each planned team name is free — one
 * request per team, so only up to this many teams, a few at a time. Above it
 * the preview says the names were not checked; createTeam still refuses a
 * taken name per team.
 */
const NAME_PROBE_MAX_TEAMS = 60;
const NAME_PROBE_CONCURRENCY = 5;

/** How long a set name may be (it becomes a Tag name and a team-name prefix). */
const MAX_SET_NAME = 40;

/** A note answer shown with results is cut at this many characters. */
const MAX_NOTE_CHARS = 500;

/** Team names are capped well under GitHub's own limit. */
const MAX_TEAM_NAME = 100;

const TERMINAL_STATUSES: ReadonlySet<TeamSetRunStatus> = new Set([
  'SOLVED',
  'INFEASIBLE',
  'FAILED',
  'CANCELED',
]);

/**
 * Background work needs Trigger.dev. The same predicate the webapp's
 * create-classroom action uses; there is no shared copy in this package.
 */
const isTriggerConfigured = (): boolean =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);

// ─── Errors ─────────────────────────────────────────────────────────────────

export type TeamSetErrorCode =
  | 'not_found'
  | 'invalid_config'
  | 'no_grouping_field'
  | 'form_not_classroom'
  | 'checks_failed'
  | 'run_not_solved'
  | 'run_stale'
  | 'already_created'
  | 'create_in_progress'
  | 'tag_conflict'
  | 'github_teams_off_unsupported'
  | 'trigger_unavailable'
  | 'github_unavailable'
  | 'name_collision';

/** Thrown for every caller-fixable refusal; callers branch on `code`. */
export class TeamSetError extends Error {
  code: TeamSetErrorCode;
  details?: unknown;

  constructor(code: TeamSetErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TeamSetError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const isTeamSetError = (error: unknown): error is TeamSetError =>
  error instanceof TeamSetError;

/**
 * The closed vocabulary a run's `error` column holds. `failRun` maps anything
 * else to `engine_error`, so a caller cannot widen it by accident.
 */
export const TEAM_SET_RUN_ERRORS = [
  'trigger_unavailable',
  'engine_error',
  'score_mismatch',
  'no_solution_in_time',
  'model_invalid',
  /** The solve task was canceled (its cancel hook reports this). */
  'canceled',
  /** QUEUED or RUNNING far past any task's lifetime; expired on read. */
  'lost',
] as const;
export type TeamSetRunErrorCode = (typeof TEAM_SET_RUN_ERRORS)[number];

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** A run's staleness snapshot (`team_set_runs.inputs`). */
export interface RunInputs {
  revision_id: string;
  responses: { id: string; user_id: string; updated_at: string; answers_hash: string }[];
  roster_user_ids: string[];
}

/** `team_set_runs.result` — user ids, in slot order. */
export interface RunResult {
  teams: { slot: number; option_id: string | null; member_user_ids: string[] }[];
}

/**
 * Whether the engine's infeasibility core is the whole story: `complete` (an
 * empty core then means the structure alone — sizes, slots, team count — is
 * impossible), `timeout` (it ran out of time narrowing the core down), `n/a`
 * (not an infeasible answer).
 */
export type SolverCoreStatus = 'complete' | 'timeout' | 'n/a';

/** Model size the engine reports; kept for diagnosing slow or huge solves. */
export interface SolverStats {
  people: number;
  slots: number;
  pairs: number;
  build_s: number;
}

/** `team_set_runs.solver`. */
export interface SolverSummary {
  status: SolverOutput['status'];
  objective: number | null;
  bound: number | null;
  wall_s: number;
  core_status?: SolverCoreStatus;
  stats?: SolverStats;
}

/** `team_set_runs.diagnostics`. */
export interface RunDiagnostics {
  issues?: CheckIssue[];
  core?: { src: string; label: string }[];
  /** On INFEASIBLE: see SolverCoreStatus. */
  core_status?: SolverCoreStatus;
  /** On INFEASIBLE: one sentence on what the core means and what to change. */
  summary?: string;
  /** Only on a `score_mismatch` failure: what the engine claimed vs. what the scorer found. */
  mismatch?: {
    engine_objective: number | null;
    scored_objective: number;
    violations: { src: string | null; detail: string }[];
  };
}

/**
 * What the Python engine prints as its final `{"type":"result"}` line. The
 * last three fields arrived with a later engine; each is optional and read
 * defensively, so an older script's output still completes a run.
 */
export interface SolverOutput {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID';
  teams: { slot: number; members: number[] }[];
  objective: number | null;
  bound: number | null;
  wall_s: number;
  core: string[];
  core_status?: SolverCoreStatus;
  /** e.g. "cpsat@9.15.6755" — the OR-Tools version actually loaded. */
  engine?: string;
  stats?: SolverStats;
}

export type CreateFailureReason =
  | TeamServiceError['code']
  | 'provider_error'
  | 'db_error'
  | 'tag_failed'
  | 'members_failed'
  | 'internal_error'
  /** The create's task died without finishing; expired on read. */
  | 'lost'
  /** The apply task was canceled mid-create (its cancel hook, via stopCreate). */
  | 'canceled';

/**
 * Why one person could not be put on their team. `no_login`: the account has
 * no GitHub login. `no_local_user`: the login no longer names a Classmoji
 * user. `github_user_not_found`: GitHub has no such user (or refused them as
 * unknown). `provider_error` / `db_error`: the GitHub call or the membership
 * write failed.
 */
export type CreateMemberFailureReason =
  | 'no_login'
  | 'no_local_user'
  | 'github_user_not_found'
  | 'provider_error'
  | 'db_error';

export interface CreateFailure {
  /** The team's name, or '*' for a failure that stopped the whole create. */
  team: string;
  reason: CreateFailureReason;
  /** On `members_failed`: who could not be added, and why (closed vocabulary). */
  members?: { user_id: string; login: string | null; reason: CreateMemberFailureReason }[];
}

export interface CreateCounts {
  teams_created: number;
  teams_failed: number;
  members_added: number;
  members_failed: number;
}

/**
 * `team_sets.create_state`.
 *
 * DONE: every team and every member made it. PARTIAL: every team exists but
 * some members (or a team's tag) could not be added — fixed by hand on the
 * Teams screen, never by another create. FAILED: at least one team was not
 * created; the same run can be claimed again and the teams already made are
 * skipped (or, when none were made, another run can be claimed instead).
 */
export interface CreateState {
  status: 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED';
  run_id: string;
  run_number: number;
  total: number;
  done: number;
  failed: CreateFailure[];
  /** `n` is the team's 1-based position in the run (absent on rows written before it existed). */
  teams: { team_id: string; name: string; n?: number }[];
  /**
   * The names planned at claim time, index-aligned with the run's teams.
   * applyCreate uses these rather than recomputing, so a team made elsewhere
   * between the claim and the apply cannot rename anything.
   */
  names?: string[];
  counts?: CreateCounts;
  /** 1 on the first claim, +1 per retry; part of the apply task's idempotency key. */
  attempt?: number;
  claimed_by: string;
  started_at: string;
  finished_at: string | null;
}

export interface TeamSetRow {
  id: string;
  classroom_id: string;
  form_id: string;
  name: string;
  config: TeamSetConfig;
  tag_id: string | null;
  created_run_id: string | null;
  create_state: CreateState | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface TeamSetRunRow {
  id: string;
  team_set_id: string;
  number: number;
  status: TeamSetRunStatus;
  config: TeamSetConfig;
  problem: TeamSetProblem;
  context: TeamSetContext;
  inputs: RunInputs;
  seed: number;
  engine: string;
  result: RunResult | null;
  metrics: TeamSetMetrics | null;
  solver: SolverSummary | null;
  diagnostics: RunDiagnostics | null;
  error: string | null;
  trigger_run_id: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface TeamSetSummary {
  id: string;
  name: string;
  form_id: string;
  tag_id: string | null;
  created: boolean;
  created_run_id: string | null;
  create_state: CreateState | null;
  run_count: number;
  latest_run: { id: string; number: number; status: TeamSetRunStatus; created_at: Date } | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunViewMember {
  user_id: string;
  name: string | null;
  login: string | null;
  placement: PersonPlacement['placement'] | null;
  requests_kept: number;
  requests_total: number;
  notes?: { field_label: string; text: string }[];
}

export interface RunViewTeam {
  n: number;
  name: string;
  option: { id: string; label: string } | null;
  size: number;
  /** Empty unless `includePeople`. */
  members: RunViewMember[];
}

/**
 * A check issue as the service hands it to a caller: with `names` resolved
 * from `user_ids` at read time (names are never stored in a run's JSON).
 */
export type NamedCheckIssue = CheckIssue & { names?: string[] };

export interface RunView {
  id: string;
  number: number;
  status: TeamSetRunStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  solver: SolverSummary | null;
  metrics: TeamSetMetrics | null;
  stale: boolean;
  stale_reasons: string[];
  /** `names` only when the view includes people. */
  issues: NamedCheckIssue[];
  core: { src: string; label: string }[];
  /** On INFEASIBLE: what the core means and what to change. */
  summary: string | null;
  teams: RunViewTeam[];
}

export interface CreatePreview {
  run_id: string;
  run_number: number;
  tag: { name: string; exists: boolean };
  github_teams: boolean;
  teams: {
    name: string;
    option: { id: string; label: string } | null;
    members: { user_id: string; name: string | null; login: string | null }[];
  }[];
  /** Human-readable cautions (no login, names not checked on GitHub). Never blocks. */
  warnings: string[];
  /** Set when this preview is for retrying a FAILED create of the same run. */
  retry?: { attempt: number; teams_already_created: number };
}

// ─── Row mapping ────────────────────────────────────────────────────────────

const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Parse a stored config. It was validated on the way in, so a failure here
 * means the schema moved under stored data — refused as `invalid_config`
 * rather than handed on half-typed.
 */
function parseStoredConfig(raw: unknown): TeamSetConfig {
  const parsed = TeamSetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TeamSetError(
      'invalid_config',
      'This team set’s stored configuration no longer validates; save it again.'
    );
  }
  return parsed.data;
}

function toSetRow(row: TeamSetDbRow): TeamSetRow {
  return {
    id: row.id,
    classroom_id: row.classroom_id,
    form_id: row.form_id,
    name: row.name,
    config: parseStoredConfig(row.config),
    tag_id: row.tag_id,
    created_run_id: row.created_run_id,
    create_state: (row.create_state as unknown as CreateState | null) ?? null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * A run row with its JSON columns typed. The config is a SNAPSHOT and is not
 * re-parsed: re-applying today's defaults to it would change what the run says
 * it was solved with.
 */
function toRunRow(row: TeamSetRunDbRow): TeamSetRunRow {
  return {
    id: row.id,
    team_set_id: row.team_set_id,
    number: row.number,
    status: row.status,
    config: row.config as unknown as TeamSetConfig,
    problem: row.problem as unknown as TeamSetProblem,
    context: row.context as unknown as TeamSetContext,
    inputs: row.inputs as unknown as RunInputs,
    seed: row.seed,
    engine: row.engine,
    result: (row.result as unknown as RunResult | null) ?? null,
    metrics: (row.metrics as unknown as TeamSetMetrics | null) ?? null,
    solver: (row.solver as unknown as SolverSummary | null) ?? null,
    diagnostics: (row.diagnostics as unknown as RunDiagnostics | null) ?? null,
    error: row.error,
    trigger_run_id: row.trigger_run_id,
    created_by: row.created_by,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/** JSON with object keys sorted, so equal answers always hash equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const answersHash = (answers: unknown): string =>
  createHash('sha256').update(stableStringify(answers)).digest('hex');

/** A set name: slug-like, ≤ 40 chars. Human input is slugified, not refused. */
function normalizeSetName(raw: string): string {
  const slug = titleToIdentifier(raw).slice(0, MAX_SET_NAME).replace(/-+$/, '');
  if (!slug) {
    throw new TeamSetError(
      'invalid_config',
      'A team set name needs at least one letter or digit (it becomes a tag name).'
    );
  }
  return slug;
}

/** Map the pure modules' config refusal onto this file's vocabulary. */
function asConfigError(error: unknown): never {
  if (error instanceof TeamSetError) throw error;
  if (error instanceof TeamSetConfigError) {
    throw new TeamSetError('invalid_config', error.message, { problems: error.problems });
  }
  throw error;
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** A database failure, as opposed to a git-provider one (Prisma codes are `P1234`). */
const isDatabaseError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError ||
  error instanceof Prisma.PrismaClientUnknownRequestError ||
  error instanceof Prisma.PrismaClientValidationError ||
  (typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^P\d{4}$/.test((error as { code: string }).code));

const readCreateState = (raw: unknown): CreateState | null =>
  (raw as CreateState | null | undefined) ?? null;

// ─── Form, roster, responses ────────────────────────────────────────────────

/**
 * The form, scoped to the classroom. A PUBLIC form has no roster and its
 * respondents have no accounts to put on a team, so it is refused here, once,
 * for every entry point.
 */
async function loadForm(classroomId: string, formId: string) {
  const form = await getPrisma().form.findFirst({
    where: { id: formId, classroom_id: classroomId },
    select: { id: true, title: true, access: true, current_revision_id: true },
  });
  if (!form) throw new TeamSetError('not_found', 'Form not found in this classroom.');
  if (form.access !== 'CLASSROOM') {
    throw new TeamSetError(
      'form_not_classroom',
      'Team sets need a CLASSROOM form: a public form’s respondents are not classroom members.'
    );
  }
  return form;
}

/** The current published revision's fields. An unpublished form has none to configure. */
async function loadCurrentRevision(form: { id: string; current_revision_id: string | null }) {
  if (!form.current_revision_id) {
    throw new TeamSetError(
      'invalid_config',
      'This form has not been published yet. Publish it before configuring teams.'
    );
  }
  const revision = await getPrisma().formRevision.findUnique({
    where: { id: form.current_revision_id },
    select: { id: true, fields: true },
  });
  if (!revision) throw new TeamSetError('not_found', 'The form’s current revision is missing.');
  return { revisionId: revision.id, fields: fieldsOf(revision.fields) };
}

/** Current STUDENT members, deduped (one person can hold several memberships), sorted. */
async function loadRosterUserIds(classroomId: string): Promise<string[]> {
  const memberships = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT' },
    select: { user_id: true },
  });
  return [...new Set(memberships.map(m => m.user_id))].sort();
}

interface LoadedResponse {
  id: string;
  user_id: string;
  updated_at: Date;
  answers: Record<string, unknown>;
}

/** SUBMITTED, identified responses of roster members, sorted by user id. */
async function loadRosterResponses(formId: string, roster: Set<string>): Promise<LoadedResponse[]> {
  const rows = await getPrisma().formResponse.findMany({
    where: { form_id: formId, submission_state: 'SUBMITTED', user_id: { not: null } },
    select: { id: true, user_id: true, updated_at: true, answers: true },
  });
  return rows
    .filter((row): row is typeof row & { user_id: string } => Boolean(row.user_id))
    .filter(row => roster.has(row.user_id))
    .map(row => ({
      id: row.id,
      user_id: row.user_id,
      updated_at: row.updated_at,
      answers: (row.answers ?? {}) as Record<string, unknown>,
    }))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
}

// ─── Set lookup ─────────────────────────────────────────────────────────────

async function findSetScoped(classroomId: string, teamSetId: string): Promise<TeamSetDbRow> {
  const row = await getPrisma().teamSet.findFirst({
    where: { id: teamSetId, classroom_id: classroomId },
  });
  if (!row) throw new TeamSetError('not_found', 'Team set not found in this classroom.');
  return row;
}

/** Counts derived from a state's lists; `members_added` is carried, not derivable. */
function recount(state: CreateState, membersAdded: number, finished: boolean): CreateCounts {
  const teamLevel = state.failed.filter(
    f => f.team !== '*' && f.reason !== 'members_failed' && f.reason !== 'tag_failed'
  ).length;
  return {
    teams_created: state.teams.length,
    // Once finished, every team that does not exist failed — including the
    // ones a whole-create failure ('*') never reached.
    teams_failed: finished ? Math.max(0, state.total - state.teams.length) : teamLevel,
    members_added: membersAdded,
    members_failed: state.failed.reduce((n, f) => n + (f.members?.length ?? 0), 0),
  };
}

/**
 * A create whose task died mid-flight says RUNNING forever and blocks every
 * retry. Past CREATE_RUNNING_TTL_MS it is FAILED 'lost' — persisted, and only
 * if the row still holds the very state that was judged (same status and
 * start time), so a create that finished or restarted meanwhile is untouched.
 */
async function expireLostCreate(row: TeamSetDbRow): Promise<TeamSetDbRow> {
  const state = readCreateState(row.create_state);
  if (!state || state.status !== 'RUNNING') return row;
  const started = Date.parse(state.started_at);
  if (Number.isFinite(started) && Date.now() - started <= CREATE_RUNNING_TTL_MS) return row;

  const lost: CreateState = {
    ...state,
    status: 'FAILED',
    failed: [...state.failed, { team: '*', reason: 'lost' }],
    finished_at: new Date().toISOString(),
  };
  lost.counts = recount(lost, state.counts?.members_added ?? 0, true);
  const prisma = getPrisma();
  const { count } = await prisma.teamSet.updateMany({
    where: {
      id: row.id,
      AND: [
        { create_state: { path: ['status'], equals: 'RUNNING' } },
        { create_state: { path: ['started_at'], equals: state.started_at } },
      ],
    },
    data: { create_state: toJson(lost) },
  });
  if (count === 0) return prisma.teamSet.findUniqueOrThrow({ where: { id: row.id } });
  return { ...row, create_state: toJson(lost) as Prisma.JsonValue };
}

// ─── Run expiry ─────────────────────────────────────────────────────────────

/** The same test the database applies in `expireLostRuns`, for a row already read. */
function isLostRun(row: { status: TeamSetRunStatus; created_at: Date; started_at: Date | null }) {
  const now = Date.now();
  if (row.status === 'QUEUED') return now - row.created_at.getTime() > RUN_QUEUED_TTL_MS;
  if (row.status === 'RUNNING' && row.started_at) {
    return now - row.started_at.getTime() > RUN_RUNNING_TTL_MS;
  }
  return false;
}

/**
 * Fail every QUEUED/RUNNING run matching `where` that has outlived any task
 * (FAILED 'lost'). The age test is in the WHERE, not decided beforehand, so a
 * run that a solve task just picked up (RUNNING, started a moment ago) can
 * never be expired by a reader that saw it QUEUED.
 */
async function expireLostRuns(where: Prisma.TeamSetRunWhereInput): Promise<void> {
  const now = Date.now();
  await getPrisma().teamSetRun.updateMany({
    where: {
      AND: [
        where,
        {
          OR: [
            { status: 'QUEUED', created_at: { lt: new Date(now - RUN_QUEUED_TTL_MS) } },
            { status: 'RUNNING', started_at: { lt: new Date(now - RUN_RUNNING_TTL_MS) } },
          ],
        },
      ],
    },
    data: { status: 'FAILED', error: 'lost', finished_at: new Date(now) },
  });
}

/**
 * The set a `setRef` names on a form: an id, or a name. Without a ref, the
 * form's only set; several sets and no ref is refused as `not_found` with the
 * names in `details`, because silently picking one would let a patch land on
 * the wrong set.
 */
async function resolveSetRow(
  classroomId: string,
  formId: string,
  setRef?: string
): Promise<TeamSetDbRow | null> {
  const prisma = getPrisma();
  if (setRef) {
    return prisma.teamSet.findFirst({
      where: {
        classroom_id: classroomId,
        form_id: formId,
        OR: [{ id: setRef }, { name: setRef }, { name: titleToIdentifier(setRef) }],
      },
    });
  }
  const rows = await prisma.teamSet.findMany({
    where: { classroom_id: classroomId, form_id: formId },
    orderBy: { created_at: 'asc' },
    take: 20,
  });
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!;
  throw new TeamSetError('not_found', 'This form has several team sets; name the one you mean.', {
    reason: 'ambiguous',
    names: rows.map(r => r.name),
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function listForForm({
  classroomId,
  formId,
}: {
  classroomId: string;
  formId: string;
}): Promise<TeamSetSummary[]> {
  await loadForm(classroomId, formId);
  // So each set's latest-run status below is not a stale QUEUED/RUNNING.
  await expireLostRuns({ team_set: { classroom_id: classroomId, form_id: formId } });
  const rows = await getPrisma().teamSet.findMany({
    where: { classroom_id: classroomId, form_id: formId },
    orderBy: { created_at: 'asc' },
    include: {
      _count: { select: { runs: true } },
      runs: {
        orderBy: { number: 'desc' },
        take: 1,
        select: { id: true, number: true, status: true, created_at: true },
      },
    },
  });
  return Promise.all(
    rows.map(async row => {
      const { create_state } = await expireLostCreate(row);
      return {
        id: row.id,
        name: row.name,
        form_id: row.form_id,
        tag_id: row.tag_id,
        created: row.created_run_id !== null,
        created_run_id: row.created_run_id,
        create_state: readCreateState(create_state),
        run_count: row._count.runs,
        latest_run: row.runs[0] ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    })
  );
}

export async function getSet({
  classroomId,
  formId,
  setRef,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
}): Promise<TeamSetRow | null> {
  await loadForm(classroomId, formId);
  const row = await resolveSetRow(classroomId, formId, setRef);
  return row ? toSetRow(await expireLostCreate(row)) : null;
}

export async function suggestForForm({
  classroomId,
  formId,
}: {
  classroomId: string;
  formId: string;
}): Promise<{ name: string; config: TeamSetConfig }> {
  const form = await loadForm(classroomId, formId);
  const { fields } = await loadCurrentRevision(form);
  return suggestConfig(fields, form.title);
}

// ─── Save ───────────────────────────────────────────────────────────────────

/**
 * Validate a config against the form's CURRENT fields. The grouping field is
 * checked first and on its own, because "the field you group by is gone" is
 * the one refusal a caller has to answer differently (pick another field or go
 * `free`) from "rule 4 is the wrong question type".
 */
function assertConfigFitsForm(config: TeamSetConfig, fields: FormField[]): void {
  if (config.grouping.mode === 'by_option') {
    // Top-level only, as validateConfigAgainstForm has it: a question inside a
    // repeat_group is answered once per teammate and cannot describe a person.
    const fieldId = config.grouping.field_id;
    const field = fields.find(f => f.id === fieldId);
    if (!field || (field.type !== 'ranked_choice' && field.type !== 'dropdown')) {
      throw new TeamSetError(
        'no_grouping_field',
        'The grouping question is not a ranked-choice or dropdown question on the current form.',
        { field_id: fieldId }
      );
    }
  }
  const problems = validateConfigAgainstForm(config, fields);
  if (problems.length > 0) {
    throw new TeamSetError('invalid_config', problems.join(' '), { problems });
  }
}

/**
 * Which set a save (or a check) is about, and the config it starts from.
 *
 * `setRef` (id or name) must exist. Otherwise `name` names one, which is new
 * when absent — how a second set on the same form is made. Otherwise the
 * form's only set, or a new one from the suggestion when there is none.
 * `fresh` (checkPatch only) starts from the suggestion even when the form
 * already has a set: the check of a second set that does not exist yet.
 */
async function resolveBase(
  classroomId: string,
  formId: string,
  { setRef, name, fresh }: { setRef?: string; name?: string; fresh?: boolean }
) {
  const form = await loadForm(classroomId, formId);
  const { fields } = await loadCurrentRevision(form);

  let existing: TeamSetDbRow | null = null;
  let newName: string | null = null;
  if (setRef) {
    existing = await resolveSetRow(classroomId, formId, setRef);
    if (!existing) throw new TeamSetError('not_found', 'Team set not found on this form.');
  } else if (name) {
    newName = normalizeSetName(name);
    existing = await getPrisma().teamSet.findFirst({
      where: { classroom_id: classroomId, form_id: formId, name: newName },
    });
  } else if (!fresh) {
    existing = await resolveSetRow(classroomId, formId);
  }

  let base: TeamSetConfig;
  if (existing) {
    base = parseStoredConfig(existing.config);
  } else {
    const suggestion = suggestConfig(fields, form.title);
    base = suggestion.config;
    newName = newName ?? normalizeSetName(suggestion.name);
  }
  return { form, fields, existing, base, name: existing?.name ?? newName! };
}

/**
 * Apply a patch, keeping the pure module's `notes` — what the patch did
 * beyond what it said (e.g. option settings dropped with a changed grouping
 * question), which a caller should relay.
 */
function patched(
  base: TeamSetConfig,
  patch: TeamSetConfigPatchInput | undefined
): { config: TeamSetConfig; notes: string[] } {
  try {
    return patch
      ? applyConfigPatchWithNotes(base, patch)
      : { config: parseStoredConfig(base), notes: [] };
  } catch (error) {
    asConfigError(error);
  }
}

/**
 * Create or update a set's config (see resolveBase for which set). A new set
 * starts from `suggestForForm`'s config, then the patch applies. `notes` is
 * what the patch did beyond what it said; relay it.
 */
export async function saveConfig({
  classroomId,
  formId,
  setRef,
  name,
  patch,
  userId,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
  name?: string;
  /** Raw or parsed; applyConfigPatch validates it either way. */
  patch?: TeamSetConfigPatchInput;
  userId: string;
}): Promise<TeamSetRow & { notes: string[] }> {
  const prisma = getPrisma();
  const {
    fields,
    existing,
    base,
    name: newName,
  } = await resolveBase(classroomId, formId, {
    ...(setRef !== undefined ? { setRef } : {}),
    ...(name !== undefined ? { name } : {}),
  });

  const { config, notes } = patched(base, patch);
  assertConfigFitsForm(config, fields);

  if (existing) {
    const updated = await prisma.teamSet.update({
      where: { id: existing.id },
      data: { config: toJson(config) },
    });
    return { ...toSetRow(updated), notes };
  }

  try {
    const created = await prisma.teamSet.create({
      data: {
        classroom_id: classroomId,
        form_id: formId,
        name: newName!,
        config: toJson(config),
        created_by: userId,
      },
    });
    return { ...toSetRow(created), notes };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TeamSetError(
        'invalid_config',
        `A team set named "${newName}" was just created on this form; save again to update it.`
      );
    }
    throw error;
  }
}

// ─── Inputs, checks, runs ───────────────────────────────────────────────────

/**
 * Everything a compile needs, plus the staleness snapshot of exactly that.
 * `config` is accepted for the contract's shape; the population rule it
 * carries (`non_respondents`) is applied by compileProblem, which gets both the
 * roster and the responses.
 */
export async function loadInputs({
  classroomId,
  formId,
}: {
  classroomId: string;
  formId: string;
  config?: TeamSetConfig;
}): Promise<{
  fields: FormField[];
  revisionId: string;
  responses: CompileInput['responses'];
  roster: CompileInput['roster'];
  snapshot: RunInputs;
}> {
  const form = await loadForm(classroomId, formId);
  const { revisionId, fields } = await loadCurrentRevision(form);
  const rosterIds = await loadRosterUserIds(classroomId);
  const responses = await loadRosterResponses(form.id, new Set(rosterIds));

  return {
    fields,
    revisionId,
    responses: responses.map(r => ({ response_id: r.id, user_id: r.user_id, answers: r.answers })),
    roster: rosterIds.map(user_id => ({ user_id })),
    snapshot: {
      revision_id: revisionId,
      responses: responses.map(r => ({
        id: r.id,
        user_id: r.user_id,
        updated_at: r.updated_at.toISOString(),
        answers_hash: answersHash(r.answers),
      })),
      roster_user_ids: rosterIds,
    },
  };
}

/** A config that no longer fits the (republished) form, as check issues. */
function configIssues(config: TeamSetConfig, fields: FormField[]): CheckIssue[] {
  try {
    assertConfigFitsForm(config, fields);
    return [];
  } catch (error) {
    if (!(error instanceof TeamSetError)) throw error;
    const problems = (error.details as { problems?: string[] } | undefined)?.problems ?? [
      error.message,
    ];
    return problems.map(message => ({ level: 'error' as const, code: error.code, message }));
  }
}

/** Compile a config against the form's current responses and run the checks. */
async function compileFor({
  classroomId,
  formId,
  setName,
  config,
  seed,
}: {
  classroomId: string;
  formId: string;
  setName: string;
  config: TeamSetConfig;
  seed: number;
}) {
  const inputs = await loadInputs({ classroomId, formId, config });
  const issues = configIssues(config, inputs.fields);
  if (issues.length > 0) return { config, inputs, issues, compiled: null };

  let compiled: ReturnType<typeof compileProblem>;
  try {
    compiled = compileProblem({
      setName,
      config,
      fields: inputs.fields,
      responses: inputs.responses,
      roster: inputs.roster,
      seed,
    });
  } catch (error) {
    asConfigError(error);
  }
  return {
    config,
    inputs,
    issues: runChecks(compiled.problem, compiled.context),
    compiled,
  };
}

const compileSet = (set: TeamSetDbRow, seed: number) =>
  compileFor({
    classroomId: set.classroom_id,
    formId: set.form_id,
    setName: set.name,
    config: parseStoredConfig(set.config),
    seed,
  });

/** How many people an issue names at most; the ids stay complete. */
const MAX_ISSUE_NAMES = 50;

/**
 * Add `names` to issues that carry `user_ids`, resolved now from User rows
 * (display name, else login). Names are never stored in a run's JSON — the
 * engine and the row see ids only — so this happens on the way out, and only
 * for callers that already show people.
 */
async function nameIssues(issues: CheckIssue[]): Promise<NamedCheckIssue[]> {
  const ids = [...new Set(issues.flatMap(issue => issue.user_ids ?? []))];
  if (ids.length === 0) return issues;
  const users = await getPrisma().user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, login: true },
  });
  const nameOf = new Map(users.map(u => [u.id, u.name?.trim() || u.login || null]));
  return issues.map(issue => {
    if (!issue.user_ids?.length) return issue;
    const names = issue.user_ids
      .slice(0, MAX_ISSUE_NAMES)
      .map(id => nameOf.get(id))
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? { ...issue, names } : issue;
  });
}

export async function checkSet({
  classroomId,
  teamSetId,
}: {
  classroomId: string;
  teamSetId: string;
}): Promise<CheckIssue[]> {
  const set = await findSetScoped(classroomId, teamSetId);
  const { issues } = await compileSet(set, 0);
  return issues;
}

/**
 * Check a patch WITHOUT saving it: apply it in memory to the set's saved
 * config (or, when there is no set yet — or `newSet` — to the form's
 * suggestion), compile against the current responses and run the checks.
 * Writes nothing: no set is created, no config changes, no run is inserted.
 *
 * A patch that does not parse is refused (`invalid_config`) exactly as
 * saveConfig refuses it; a config that parses but does not fit the form comes
 * back as error-level issues, like every other blocking problem.
 */
export async function checkPatch({
  classroomId,
  formId,
  setRef,
  name,
  newSet,
  patch,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
  name?: string;
  newSet?: boolean;
  patch?: TeamSetConfigPatchInput;
}): Promise<{
  set: { id: string; name: string } | null;
  name: string;
  config: TeamSetConfig;
  notes: string[];
  issues: NamedCheckIssue[];
}> {
  const {
    existing,
    base,
    name: setName,
  } = await resolveBase(classroomId, formId, {
    ...(setRef !== undefined ? { setRef } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(newSet ? { fresh: true } : {}),
  });
  const { config, notes } = patched(base, patch);
  const { issues } = await compileFor({ classroomId, formId, setName, config, seed: 0 });
  return {
    set: existing ? { id: existing.id, name: existing.name } : null,
    name: setName,
    config,
    notes,
    issues: await nameIssues(issues),
  };
}

/**
 * Compile, check, and queue a solve.
 *
 * Any error-level issue returns `{ run: null, issues }` and inserts nothing.
 * Otherwise the run is numbered under the set's ROW LOCK (max+1 alone is a race
 * at READ COMMITTED: two starts would both read 3 and one would hit the unique
 * index), inserted QUEUED with the warnings in `diagnostics.issues`, and handed
 * to Trigger. No Trigger, or a trigger call that throws, leaves the row FAILED
 * `trigger_unavailable` — returned, not thrown, so the caller can say so.
 */
export async function startRun({
  classroomId,
  teamSetId,
  userId,
  seed,
}: {
  classroomId: string;
  teamSetId: string;
  userId: string;
  seed?: number;
}): Promise<{ run: TeamSetRunRow | null; issues: NamedCheckIssue[] }> {
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED)) {
    throw new TeamSetError('invalid_config', `seed must be an integer from 0 to ${MAX_SEED}.`);
  }
  const set = await findSetScoped(classroomId, teamSetId);
  const runSeed = seed ?? Math.floor(Math.random() * MAX_SEED);
  const { config, inputs, issues, compiled } = await compileSet(set, runSeed);

  if (!compiled || issues.some(issue => issue.level === 'error')) {
    return { run: null, issues: await nameIssues(issues) };
  }

  const prisma = getPrisma();
  const inserted = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM team_sets WHERE id = ${set.id} FOR UPDATE`;
    const last = await tx.teamSetRun.aggregate({
      where: { team_set_id: set.id },
      _max: { number: true },
    });
    return tx.teamSetRun.create({
      data: {
        team_set_id: set.id,
        number: (last._max.number ?? 0) + 1,
        status: 'QUEUED',
        config: toJson(config),
        problem: toJson(compiled.problem),
        context: toJson(compiled.context),
        inputs: toJson(inputs.snapshot),
        seed: runSeed,
        engine: TEAM_SET_ENGINE,
        diagnostics: issues.length > 0 ? toJson({ issues }) : Prisma.DbNull,
        created_by: userId,
      },
    });
  });

  let final = inserted;
  let triggered = false;
  if (isTriggerConfigured()) {
    try {
      // One solve per run, however often this call is retried by a client or
      // a flaky network: Trigger returns the existing run for a repeated key.
      const handle = await tasks.trigger(
        SOLVE_TASK_ID,
        { runId: inserted.id },
        { idempotencyKey: `${SOLVE_TASK_ID}:${inserted.id}` }
      );
      triggered = true;
      final = await prisma.teamSetRun.update({
        where: { id: inserted.id },
        data: { trigger_run_id: handle.id },
      });
    } catch (error) {
      if (triggered) throw error;
      console.error(`[teamSet] could not queue solve for run ${inserted.id}`, error);
    }
  }
  if (!triggered) {
    final = await prisma.teamSetRun.update({
      where: { id: inserted.id },
      data: { status: 'FAILED', error: 'trigger_unavailable', finished_at: new Date() },
    });
  }
  return { run: toRunRow(final), issues: await nameIssues(issues) };
}

export interface TeamSetRunListItem {
  id: string;
  number: number;
  status: TeamSetRunStatus;
  created_at: Date;
  finished_at: Date | null;
  error: string | null;
  metrics: TeamSetMetrics | null;
  /** Only with `withStaleness`, and only for SOLVED runs; null otherwise. */
  stale?: boolean | null;
}

/**
 * A set's runs, newest first, as a light list: the heavy columns (problem,
 * context, result) are never selected, so a set with fifty runs of a
 * 300-person class is still a small read.
 *
 * `withStaleness` adds `stale` for the SOLVED runs (the only ones it decides
 * anything for — whether they can still be created). It reads those runs'
 * snapshots and the form's current state ONCE for all of them, on the light
 * path `staleness` uses.
 */
export async function listRuns({
  classroomId,
  teamSetId,
  limit = 10,
  withStaleness = false,
}: {
  classroomId: string;
  teamSetId: string;
  /** Default 10, clamped to 1..50. */
  limit?: number;
  withStaleness?: boolean;
}): Promise<TeamSetRunListItem[]> {
  const set = await findSetScoped(classroomId, teamSetId);
  await expireLostRuns({ team_set_id: set.id });
  const take = Math.min(50, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 10)));
  const prisma = getPrisma();
  const rows = await prisma.teamSetRun.findMany({
    where: { team_set_id: set.id },
    orderBy: { number: 'desc' },
    take,
    select: {
      id: true,
      number: true,
      status: true,
      created_at: true,
      finished_at: true,
      error: true,
      metrics: true,
    },
  });
  const items: TeamSetRunListItem[] = rows.map(row => ({
    ...row,
    metrics: (row.metrics as unknown as TeamSetMetrics | null) ?? null,
  }));
  if (!withStaleness) return items;

  const solvedIds = items.filter(item => item.status === 'SOLVED').map(item => item.id);
  const snapshots =
    solvedIds.length > 0
      ? await prisma.teamSetRun.findMany({
          where: { id: { in: solvedIds } },
          select: { id: true, inputs: true, config: true },
        })
      : [];
  const staleById = new Map<string, boolean>();
  if (snapshots.length > 0) {
    const form = await loadForm(classroomId, set.form_id);
    const current = await loadCurrentState(classroomId, form);
    const reasons = await staleReasons(
      snapshots.map(row => ({
        inputs: row.inputs as unknown as RunInputs,
        nonRespondents: (row.config as { non_respondents?: string } | null)?.non_respondents,
      })),
      current
    );
    snapshots.forEach((row, i) => staleById.set(row.id, reasons[i]!.length > 0));
  }
  return items.map(item => ({
    ...item,
    stale: item.status === 'SOLVED' ? (staleById.get(item.id) ?? null) : null,
  }));
}

/**
 * A run by number (1, "3") or id, scoped through its set to the classroom. A
 * number outside the INT4 column's range cannot name a run: `not_found`, not a
 * database overflow error.
 */
export async function getRun({
  classroomId,
  teamSetId,
  runRef,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
}): Promise<TeamSetRunRow> {
  const set = await findSetScoped(classroomId, teamSetId);
  const asNumber =
    typeof runRef === 'number' ? runRef : /^\d+$/.test(runRef.trim()) ? Number(runRef) : null;
  if (
    asNumber !== null &&
    !(Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= MAX_RUN_NUMBER)
  ) {
    throw new TeamSetError('not_found', 'Run not found in this team set.');
  }
  const prisma = getPrisma();
  const find = () =>
    asNumber !== null
      ? prisma.teamSetRun.findUnique({
          where: { team_set_id_number: { team_set_id: set.id, number: asNumber } },
        })
      : prisma.teamSetRun.findFirst({
          where: { id: String(runRef), team_set_id: set.id },
        });
  let row = await find();
  if (!row) throw new TeamSetError('not_found', 'Run not found in this team set.');
  if (isLostRun(row)) {
    await expireLostRuns({ id: row.id });
    row = (await find()) ?? row;
  }
  return toRunRow(row);
}

async function findRunScoped(classroomId: string, runId: string): Promise<TeamSetRunDbRow> {
  const row = await getPrisma().teamSetRun.findFirst({
    where: { id: runId, team_set: { classroom_id: classroomId } },
  });
  if (!row) throw new TeamSetError('not_found', 'Run not found in this classroom.');
  return row;
}

/**
 * Poll the run until it is terminal or `timeoutMs` passes; returns it either
 * way. Each poll reads three columns (status and the two timestamps lazy
 * expiry needs); the full row is read once, at the end.
 */
export async function waitForRun({
  classroomId,
  runId,
  timeoutMs,
  pollMs = DEFAULT_POLL_MS,
}: {
  classroomId: string;
  runId: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<TeamSetRunRow> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const poll = async () => {
    const row = await getPrisma().teamSetRun.findFirst({
      where: { id: runId, team_set: { classroom_id: classroomId } },
      select: { status: true, created_at: true, started_at: true },
    });
    if (!row) throw new TeamSetError('not_found', 'Run not found in this classroom.');
    if (!isLostRun(row)) return row.status;
    await expireLostRuns({ id: runId });
    return 'FAILED' as const;
  };
  let status = await poll();
  while (!TERMINAL_STATUSES.has(status) && Date.now() < deadline) {
    await sleep(Math.max(50, Math.min(pollMs, deadline - Date.now())));
    status = await poll();
  }
  return toRunRow(await findRunScoped(classroomId, runId));
}

// ─── Staleness ──────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The form's state now, as a staleness check needs it — WITHOUT answers.
 * Answers are only needed for a response whose `updated_at` moved since a
 * snapshot (it may have been staff triage, which changes no answer), and
 * `staleReasons` fetches exactly those.
 */
interface CurrentState {
  revisionId: string | null;
  rosterIds: string[];
  responses: Map<string, { id: string; updated_at: string }>;
}

async function loadCurrentState(
  classroomId: string,
  form: { id: string; current_revision_id: string | null }
): Promise<CurrentState> {
  const rosterIds = await loadRosterUserIds(classroomId);
  const roster = new Set(rosterIds);
  const rows = await getPrisma().formResponse.findMany({
    where: { form_id: form.id, submission_state: 'SUBMITTED', user_id: { not: null } },
    select: { id: true, user_id: true, updated_at: true },
  });
  const responses = new Map<string, { id: string; updated_at: string }>();
  for (const row of rows) {
    if (!row.user_id || !roster.has(row.user_id)) continue;
    responses.set(row.user_id, { id: row.id, updated_at: row.updated_at.toISOString() });
  }
  return { revisionId: form.current_revision_id, rosterIds, responses };
}

/**
 * Why each snapshot is stale against `current` (empty = not stale). One
 * answers read covers every snapshot, and it reads only the responses whose
 * `updated_at` moved.
 */
async function staleReasons(
  snapshots: { inputs: RunInputs; nonRespondents: string | undefined }[],
  current: CurrentState
): Promise<string[][]> {
  const toHash = new Set<string>();
  for (const { inputs } of snapshots) {
    for (const before of inputs.responses) {
      const now = current.responses.get(before.user_id);
      if (
        now &&
        now.id === before.id &&
        now.updated_at !== before.updated_at &&
        before.answers_hash
      ) {
        toHash.add(now.id);
      }
    }
  }
  const hashes = new Map<string, string>();
  if (toHash.size > 0) {
    const rows = await getPrisma().formResponse.findMany({
      where: { id: { in: [...toHash] } },
      select: { id: true, answers: true },
    });
    for (const row of rows) hashes.set(row.id, answersHash(row.answers ?? {}));
  }

  return snapshots.map(({ inputs, nonRespondents }) => {
    const reasons: string[] = [];
    if (current.revisionId !== inputs.revision_id) {
      reasons.push('The form was republished after this run.');
    }
    const snapByUser = new Map(inputs.responses.map(r => [r.user_id, r]));
    let edited = 0;
    let removed = 0;
    for (const [userId, before] of snapByUser) {
      const now = current.responses.get(userId);
      if (!now) {
        removed += 1;
        continue;
      }
      if (now.id !== before.id) edited += 1;
      else if (now.updated_at === before.updated_at) continue;
      else if (!before.answers_hash || hashes.get(now.id) !== before.answers_hash) edited += 1;
    }
    let added = 0;
    for (const userId of current.responses.keys()) if (!snapByUser.has(userId)) added += 1;

    if (edited > 0) reasons.push(`${plural(edited, 'response was', 'responses were')} edited.`);
    if (added > 0) reasons.push(`${plural(added, 'new response', 'new responses')} came in.`);
    if (removed > 0) {
      reasons.push(`${plural(removed, 'response was', 'responses were')} withdrawn or removed.`);
    }

    if (nonRespondents !== 'exclude') {
      const before = new Set(inputs.roster_user_ids);
      const now = new Set(current.rosterIds);
      const joined = current.rosterIds.filter(id => !before.has(id)).length;
      const left = inputs.roster_user_ids.filter(id => !now.has(id)).length;
      if (joined > 0 || left > 0) {
        reasons.push(`The roster changed (${joined} joined, ${left} left).`);
      }
    }
    return reasons;
  });
}

/**
 * Whether a run's inputs still match the form. Takes only what it reads —
 * the set id, the snapshot and the population rule — so a caller holding a
 * light row need not load the problem or context to ask.
 */
export async function staleness({
  classroomId,
  run,
}: {
  classroomId: string;
  run: { team_set_id: string; inputs: RunInputs; config: { non_respondents?: string } };
}): Promise<{ stale: boolean; reasons: string[] }> {
  const set = await findSetScoped(classroomId, run.team_set_id);
  const form = await loadForm(classroomId, set.form_id);
  const current = await loadCurrentState(classroomId, form);
  const [reasons] = await staleReasons(
    [{ inputs: run.inputs, nonRespondents: run.config.non_respondents }],
    current
  );
  return { stale: reasons!.length > 0, reasons: reasons! };
}

// ─── Team naming ────────────────────────────────────────────────────────────

/** The grouping field's option labels on the revision the run was solved against. */
async function optionLabelsFor(run: TeamSetRunRow): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (run.config.grouping.mode !== 'by_option') return labels;
  const revision = await getPrisma().formRevision.findUnique({
    where: { id: run.inputs.revision_id },
    select: { fields: true },
  });
  const fieldId = run.config.grouping.field_id;
  const field = flattenFields(fieldsOf(revision?.fields)).find(f => f.id === fieldId);
  const options = (field?.options as { id: string; label: string }[] | undefined) ?? [];
  for (const option of options) labels.set(option.id, option.label);
  return labels;
}

/**
 * One name per team, from the run's template. Pure and shared by describeRun,
 * previewCreate and claimCreate (which stores the result for applyCreate), so
 * the preview an owner approves names exactly the teams that get created.
 * Tokens: {set}, {n} (two digits), {option} (the option's `team_name`, else a
 * 24-char slug of its label).
 *
 * Every name is unique by its predicted GitHub slug — against the other names
 * in the set, against `taken` (slugs already used, e.g. the classroom's
 * existing teams) and against the reserved classroom-team slugs. A clash gets
 * `-2`, `-3`, … appended AFTER truncating to the length cap, and the loop
 * keeps counting until the result is free, so a suffix can neither push a name
 * over the cap nor land on another taken name.
 */
export function teamNamesFor(
  setName: string,
  config: TeamSetConfig,
  teams: { option_id: string | null }[],
  optionLabels: Map<string, string>,
  taken: Iterable<string> = []
): string[] {
  const template = config.team_name_template || '{set}-{n}';
  const used = new Set([...taken].map(slug => slug.toLowerCase()));
  const isFree = (name: string) => {
    const slug = predictTeamSlug(name);
    return !used.has(slug) && !isReservedSlug(slug);
  };
  return teams.map((team, index) => {
    const n = String(index + 1).padStart(2, '0');
    let option = '';
    if (team.option_id) {
      const custom = config.options?.[team.option_id]?.team_name;
      const label = optionLabels.get(team.option_id) ?? team.option_id;
      option = (custom?.trim() || titleToIdentifier(label).slice(0, 24)).replace(/-+$/, '');
    }
    let name = template
      .replaceAll('{set}', setName)
      .replaceAll('{n}', n)
      .replaceAll('{option}', option)
      .replace(/\s+/g, ' ')
      .replace(/-{2,}/g, '-')
      .trim()
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_TEAM_NAME);
    if (!name) name = `${setName}-${n}`;
    let unique = name;
    for (let k = 2; !isFree(unique); k++) {
      const suffix = `-${k}`;
      unique = `${name.slice(0, MAX_TEAM_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
    }
    used.add(predictTeamSlug(unique));
    return unique;
  });
}

/** The classroom's team slugs — what a new team name must not collide with. */
async function classroomTeamSlugs(classroomId: string, exceptTeamIds: Set<string> = new Set()) {
  const teams = await getPrisma().team.findMany({
    where: { classroom_id: classroomId },
    select: { id: true, slug: true },
  });
  return teams.filter(team => !exceptTeamIds.has(team.id)).map(team => team.slug);
}

/**
 * The names a run's teams go by: for the run whose create was claimed, the
 * names that claim stored (those are the teams that exist); for any other
 * run, what a create would name them against the classroom's teams today.
 */
async function plannedNames(
  set: TeamSetDbRow,
  run: TeamSetRunRow,
  optionLabels: Map<string, string>
): Promise<string[]> {
  const teams = run.result?.teams ?? [];
  const state = readCreateState(set.create_state);
  if (set.created_run_id === run.id && state?.names?.length === teams.length) return state.names;
  return teamNamesFor(
    set.name,
    run.config,
    teams,
    optionLabels,
    await classroomTeamSlugs(set.classroom_id)
  );
}

// ─── Describe ───────────────────────────────────────────────────────────────

const RULE_SRC = /^[0-9a-f-]{36}:([a-z_]+)$/i;

/**
 * Map a solver/check `src` to something a human can read. `option:<id>` uses
 * the option's LABEL and says which way it was forced. A src this run's
 * context does not know (a rule since removed, a newer engine's structural
 * src) still gets a sentence rather than a raw id.
 */
function labelForSrc(
  src: string,
  context: TeamSetContext,
  problem: TeamSetProblem,
  optionLabels: Map<string, string>
): string {
  const rule = context.rules?.find(r => r.id === src);
  if (rule) return `${rule.label} (${rule.job}, ${rule.strength})`;
  if (src.startsWith('pin:')) {
    const pinId = src.slice(4);
    const pin = context.pins?.find(p => p.id === pinId || p.id === src);
    return pin ? `Pin ${pinId}: ${pin.label}` : `Pin ${pinId}`;
  }
  if (src.startsWith('option:')) {
    const optionId = src.slice(7);
    const label = optionLabels.get(optionId);
    const topic = label ? `Topic '${label}'` : 'A topic that is no longer on the form';
    const open = problem.options?.find(option => option.id === optionId)?.open;
    if (open === 'open') return `${topic} is forced open`;
    if (open === 'closed') return `${topic} is closed`;
    return `${topic} has an open/closed setting`;
  }
  if (src === 'non_respondents') return 'Spread out people who did not respond';
  const job = RULE_SRC.exec(src)?.[1];
  if (job) return `A rule (${job}) on a question that is no longer on the form`;
  return 'Another setting of this team set';
}

/**
 * The one sentence an INFEASIBLE run carries: what its core means and what
 * to change. The core names rules and pins, but it is their combination WITH
 * the structural limits (sizes, teams per option, team count — which have no
 * src of their own) that cannot be met.
 */
function infeasibleSummary(coreSize: number, coreStatus: SolverCoreStatus | undefined): string {
  const LIMITS = 'the team-size, teams-per-option and team-count limits';
  if (coreStatus === 'timeout') {
    return (
      'No grouping meets every must rule and pin, but the solver ran out of time before it could ' +
      `tell which ones collide${coreSize > 0 ? ' (the list below may be incomplete)' : ''}. ` +
      `Loosen must rules or pins one at a time, or ${LIMITS}.`
    );
  }
  if (coreSize > 0) {
    return (
      `The settings listed cannot all be met together within ${LIMITS}. ` +
      'Loosen or remove one of them (or change those limits), then run again.'
    );
  }
  if (coreStatus === 'complete') {
    return `No rule or pin is to blame: ${LIMITS} alone cannot place everyone. Change those limits.`;
  }
  return `No grouping meets every must rule and pin within ${LIMITS}. Loosen them, then run again.`;
}

/** Person indices for a stored result, as the metrics/scorer functions take them. */
function assignmentOf(run: TeamSetRunRow): { slot: number; members: number[] }[] {
  const index = new Map(run.problem.people.map((userId, i) => [userId, i]));
  return (run.result?.teams ?? []).map(team => ({
    slot: team.slot,
    members: team.member_user_ids
      .map(id => index.get(id))
      .filter((i): i is number => i !== undefined),
  }));
}

export async function describeRun({
  classroomId,
  run,
  includePeople,
}: {
  classroomId: string;
  run: TeamSetRunRow;
  includePeople: boolean;
}): Promise<RunView> {
  const set = await findSetScoped(classroomId, run.team_set_id);
  const { stale, reasons } = await staleness({ classroomId, run });
  const issues = run.diagnostics?.issues ?? [];

  const view: RunView = {
    id: run.id,
    number: run.number,
    status: run.status,
    error: run.error,
    created_at: run.created_at.toISOString(),
    finished_at: run.finished_at?.toISOString() ?? null,
    solver: run.solver,
    metrics: run.metrics,
    stale,
    stale_reasons: reasons,
    // Names (e.g. who has not responded) only for a view that shows people.
    issues: includePeople ? await nameIssues(issues) : issues,
    core: run.diagnostics?.core ?? [],
    summary: run.diagnostics?.summary ?? null,
    teams: [],
  };
  if (run.status !== 'SOLVED' || !run.result) return view;

  const optionLabels = await optionLabelsFor(run);
  const names = await plannedNames(set, run, optionLabels);

  let placements = new Map<string, PersonPlacement>();
  let users = new Map<string, { name: string | null; login: string | null }>();
  let notesByUser = new Map<string, { field_label: string; text: string }[]>();

  if (includePeople) {
    const { people } = computeMetrics(run.problem, run.context, assignmentOf(run));
    placements = new Map(people.map(p => [p.user_id, p]));

    const memberIds = run.result.teams.flatMap(t => t.member_user_ids);
    const userRows = await getPrisma().user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, login: true },
    });
    users = new Map(userRows.map(u => [u.id, { name: u.name, login: u.login }]));
    notesByUser = await loadNotes(set.form_id, run, memberIds);
  }

  view.teams = run.result.teams.map((team, i) => {
    const members: RunViewMember[] = includePeople
      ? team.member_user_ids
          .map(userId => {
            const placement = placements.get(userId);
            const user = users.get(userId);
            const requests = placement?.requests ?? [];
            const notes = notesByUser.get(userId);
            return {
              user_id: userId,
              name: user?.name ?? null,
              login: user?.login ?? null,
              placement: placement?.placement ?? null,
              requests_kept: requests.filter(r => r.kept).length,
              requests_total: requests.length,
              ...(notes && notes.length > 0 ? { notes } : {}),
            };
          })
          .sort((a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''))
      : [];
    return {
      n: i + 1,
      name: names[i]!,
      option: team.option_id
        ? { id: team.option_id, label: optionLabels.get(team.option_id) ?? team.option_id }
        : null,
      size: team.member_user_ids.length,
      members,
    };
  });
  return view;
}

/**
 * Notes shown next to each person: answers to fields that carry a `note` rule,
 * read from the responses NOW (they are for reading, not solving). Text-shaped
 * answers only, trimmed and capped. An `email`-type field is skipped even when
 * it carries a note rule: this view reaches MCP clients, and the contract for
 * it is "no emails".
 */
async function loadNotes(
  formId: string,
  run: TeamSetRunRow,
  userIds: string[]
): Promise<Map<string, { field_label: string; text: string }[]>> {
  const out = new Map<string, { field_label: string; text: string }[]>();
  const noteFieldIds =
    run.context.note_field_ids ??
    run.config.rules.filter(r => r.job === 'note' && r.strength !== 'off').map(r => r.field_id);
  if (noteFieldIds.length === 0 || userIds.length === 0) return out;

  const revision = await getPrisma().formRevision.findUnique({
    where: { id: run.inputs.revision_id },
    select: { fields: true },
  });
  const fieldsById = new Map(flattenFields(fieldsOf(revision?.fields)).map(f => [f.id, f]));
  const noteFields = noteFieldIds
    .map(id => fieldsById.get(id))
    .filter((f): f is FormField => Boolean(f) && f!.type !== 'email');
  if (noteFields.length === 0) return out;

  const responses = await getPrisma().formResponse.findMany({
    where: { form_id: formId, submission_state: 'SUBMITTED', user_id: { in: userIds } },
    select: { user_id: true, answers: true },
  });
  for (const response of responses) {
    if (!response.user_id) continue;
    const answers = (response.answers ?? {}) as Record<string, unknown>;
    const notes = noteFields
      .map(field => {
        const value = answers[field.id];
        if (typeof value !== 'string' || !value.trim()) return null;
        const text = value.trim();
        return {
          field_label: String(field.label ?? ''),
          text: text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}…` : text,
        };
      })
      .filter((n): n is { field_label: string; text: string } => n !== null);
    if (notes.length > 0) out.set(response.user_id, notes);
  }
  return out;
}

// ─── Create: preview, claim, apply ──────────────────────────────────────────

interface CreatePlan {
  set: TeamSetDbRow;
  run: TeamSetRunRow;
  tag: { id: string; name: string } | null;
  teams: { n: number; name: string; option_id: string | null; member_user_ids: string[] }[];
  optionLabels: Map<string, string>;
  /** The FAILED create this claim retries, or null for a first create. */
  previous: CreateState | null;
  /** Positions (1-based `n`) of teams a previous attempt of THIS run already made. */
  alreadyCreated: Set<number>;
}

/** Which positions a state records as created; by `n`, else by name. */
function createdPositions(state: CreateState): Set<number> {
  const positions = new Set<number>();
  for (const team of state.teams) {
    const n = team.n ?? (state.names ? state.names.indexOf(team.name) + 1 : 0);
    if (n > 0) positions.add(n);
  }
  return positions;
}

/**
 * Everything previewCreate and claimCreate both refuse on, in the order a
 * caller can act on them. Uses the RUN's config snapshot (template,
 * github_teams): the preview of a run must not change because the set's config
 * was edited after it was solved.
 *
 * A set whose create was already claimed may be claimed again only when that
 * create FAILED: for the same run (the teams it made are skipped), or — when
 * it made no team at all — for any run. RUNNING is `create_in_progress`;
 * DONE and PARTIAL (every team exists) are `already_created`.
 */
async function planCreate(
  classroomId: string,
  teamSetId: string,
  runRef: string | number
): Promise<CreatePlan> {
  const set = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  const run = await getRun({ classroomId, teamSetId, runRef });

  let previous: CreateState | null = null;
  if (set.created_run_id) {
    const state = readCreateState(set.create_state);
    if (!state || state.status === 'RUNNING') {
      throw new TeamSetError('create_in_progress', 'Teams for this set are being created now.');
    }
    const retryable =
      state.status === 'FAILED' && (set.created_run_id === run.id || state.teams.length === 0);
    if (!retryable) {
      throw new TeamSetError(
        'already_created',
        state.status === 'FAILED'
          ? `Teams were partly created from run ${state.run_number}; only that run can be retried.`
          : 'Teams were already created from this set. Make a new team set to create another grouping.',
        { run_number: state.run_number, status: state.status }
      );
    }
    previous = state;
  }
  if (run.status !== 'SOLVED' || !run.result) {
    throw new TeamSetError('run_not_solved', `Run ${run.number} is ${run.status}, not SOLVED.`, {
      status: run.status,
    });
  }
  if (run.config.github_teams === false) {
    throw new TeamSetError(
      'github_teams_off_unsupported',
      'Creating teams without GitHub teams is not supported yet.'
    );
  }
  const { stale, reasons } = await staleness({ classroomId, run });
  if (stale) {
    throw new TeamSetError(
      'run_stale',
      `Run ${run.number} is out of date: ${reasons.join(' ')} Start a new run first.`,
      { reasons }
    );
  }

  // Teams a previous attempt of THIS run made are ours: they sit on the tag and
  // hold their names, and neither is a conflict for the retry.
  const sameRun = previous !== null && set.created_run_id === run.id;
  const ours = new Set(sameRun ? previous!.teams.map(t => t.team_id) : []);

  const tag = await getPrisma().tag.findUnique({
    where: { classroom_id_name: { classroom_id: classroomId, name: set.name } },
    select: { id: true, name: true, teams: { select: { team_id: true } } },
  });
  const foreignTagged = tag ? tag.teams.filter(t => !ours.has(t.team_id)).length : 0;
  if (foreignTagged > 0) {
    throw new TeamSetError(
      'tag_conflict',
      `The tag "${set.name}" already has teams. Make a new team set with a different name and run it.`,
      { tag: set.name, teams: foreignTagged }
    );
  }

  const optionLabels = await optionLabelsFor(run);
  const names = teamNamesFor(
    set.name,
    run.config,
    run.result.teams,
    optionLabels,
    await classroomTeamSlugs(classroomId, ours)
  );
  const alreadyCreated = new Set<number>();
  if (sameRun) {
    // The teams that exist keep the names they were made with.
    for (const team of previous!.teams) {
      const n = team.n ?? (previous!.names ? previous!.names.indexOf(team.name) + 1 : 0);
      if (n < 1 || n > names.length) continue;
      names[n - 1] = team.name;
      alreadyCreated.add(n);
    }
  }
  return {
    set,
    run,
    tag: tag ? { id: tag.id, name: tag.name } : null,
    teams: run.result.teams.map((team, i) => ({
      n: i + 1,
      name: names[i]!,
      option_id: team.option_id,
      member_user_ids: team.member_user_ids,
    })),
    optionLabels,
    previous,
    alreadyCreated: sameRun ? alreadyCreated : new Set(),
  };
}

/** Run `work` over `items` with at most `limit` in flight. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/**
 * Before an owner is asked to approve, make sure the create can reach GitHub
 * and that no planned name is already a team in the organization (another
 * classroom in the same org, or a team made by hand, is invisible to the
 * local check). The organization read comes FIRST and must succeed: a dead
 * installation can answer a team lookup with 404, which would otherwise read
 * as "name free". Refuses `github_unavailable` / `name_collision`; returns a
 * warning when there were too many teams to check one by one.
 */
async function githubPreflight(classroomId: string, names: string[]): Promise<string[]> {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: { git_organization: true },
  });
  const org = classroom?.git_organization;
  const unavailable = () =>
    new TeamSetError(
      'github_unavailable',
      'The classroom’s GitHub organization cannot be reached (is the Classmoji app installed on it?).'
    );
  if (!org?.login) throw unavailable();
  let provider: ReturnType<typeof getGitProvider>;
  try {
    provider = getGitProvider(org);
    await provider.getOrganization(org.login);
  } catch (error) {
    console.error(`[teamSet] GitHub pre-flight failed for classroom ${classroomId}`, error);
    throw unavailable();
  }

  if (names.length > NAME_PROBE_MAX_TEAMS) {
    return [
      `Team names were not checked against GitHub (more than ${NAME_PROBE_MAX_TEAMS} teams); a taken name fails only that team.`,
    ];
  }
  const collisions: string[] = [];
  let failed = false;
  await eachLimited(names, NAME_PROBE_CONCURRENCY, async name => {
    try {
      await provider.getTeam(org.login, predictTeamSlug(name));
      collisions.push(name);
    } catch (error) {
      if (statusOf(error) !== 404) failed = true;
    }
  });
  if (failed) throw unavailable();
  if (collisions.length > 0) {
    const ordered = names.filter(name => collisions.includes(name));
    throw new TeamSetError(
      'name_collision',
      `${plural(ordered.length, 'team name is', 'team names are')} already used in the GitHub organization: ${ordered.join(', ')}. Change team_name_template (or the set name) and run again.`,
      { names: ordered }
    );
  }
  return [];
}

export async function previewCreate({
  classroomId,
  teamSetId,
  runRef,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
}): Promise<CreatePreview> {
  const plan = await planCreate(classroomId, teamSetId, runRef);
  const toMake = plan.teams.filter(team => !plan.alreadyCreated.has(team.n));
  const warnings = await githubPreflight(
    classroomId,
    toMake.map(team => team.name)
  );

  const memberIds = plan.teams.flatMap(t => t.member_user_ids);
  const users = await getPrisma().user.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, name: true, login: true },
  });
  const byId = new Map(users.map(u => [u.id, u]));
  const noLogin = toMake.flatMap(t => t.member_user_ids).filter(id => !byId.get(id)?.login).length;
  if (noLogin > 0) {
    warnings.unshift(
      `${plural(noLogin, 'person has', 'people have')} no GitHub login and cannot be added to a GitHub team.`
    );
  }

  return {
    run_id: plan.run.id,
    run_number: plan.run.number,
    tag: { name: plan.set.name, exists: plan.tag !== null },
    github_teams: plan.run.config.github_teams !== false,
    teams: plan.teams.map(team => ({
      name: team.name,
      option: team.option_id
        ? { id: team.option_id, label: plan.optionLabels.get(team.option_id) ?? team.option_id }
        : null,
      members: team.member_user_ids.map(id => ({
        user_id: id,
        name: byId.get(id)?.name ?? null,
        login: byId.get(id)?.login ?? null,
      })),
    })),
    warnings,
    ...(plan.alreadyCreated.size > 0 && plan.previous
      ? {
          retry: {
            attempt: (plan.previous.attempt ?? 1) + 1,
            teams_already_created: plan.alreadyCreated.size,
          },
        }
      : {}),
  };
}

/**
 * Claim the set for one run's create and queue the apply task.
 *
 * A first claim is `updateMany … WHERE created_run_id IS NULL`; a retry of a
 * FAILED create is `updateMany … WHERE created_run_id = <the failed run> AND
 * create_state is that very FAILED state` (status and start time). Either way
 * two confirms that both passed the checks race on one statement and exactly
 * one wins; the loser is told `create_in_progress` (or `already_created`).
 *
 * A retry keeps the teams the failed attempt made (and their member/tag
 * failures) and drops the failures of teams it will try again. The planned
 * names are stored in the state, so applyCreate creates exactly the names the
 * preview showed.
 *
 * The apply task is queued with an idempotency key per attempt. If it cannot
 * be queued the claim is RELEASED — back to unclaimed, or back to the FAILED
 * state it retried — and `trigger_unavailable` is thrown.
 *
 * `runId` may also be a run number; it is resolved through the set.
 */
export async function claimCreate({
  classroomId,
  teamSetId,
  runId,
  userId,
}: {
  classroomId: string;
  teamSetId: string;
  runId: string;
  userId: string;
}): Promise<void> {
  const plan = await planCreate(classroomId, teamSetId, runId);
  if (!isTriggerConfigured()) {
    throw new TeamSetError(
      'trigger_unavailable',
      'Background jobs are not configured here, so teams cannot be created.'
    );
  }

  const previous = plan.previous;
  const kept = plan.alreadyCreated.size > 0 ? previous! : null;
  const keptNames = new Set(
    plan.teams.filter(team => plan.alreadyCreated.has(team.n)).map(team => team.name)
  );
  const state: CreateState = {
    status: 'RUNNING',
    run_id: plan.run.id,
    run_number: plan.run.number,
    total: plan.teams.length,
    done: plan.alreadyCreated.size,
    failed: kept ? kept.failed.filter(f => f.team !== '*' && keptNames.has(f.team)) : [],
    teams: kept
      ? kept.teams.map(team => ({
          ...team,
          n: team.n ?? plan.teams.find(t => t.name === team.name)?.n,
        }))
      : [],
    names: plan.teams.map(team => team.name),
    attempt: (previous?.attempt ?? (previous ? 1 : 0)) + 1,
    claimed_by: userId,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  state.counts = recount(state, kept?.counts?.members_added ?? 0, false);

  const prisma = getPrisma();
  const claimed = await prisma.teamSet.updateMany({
    where: previous
      ? {
          id: plan.set.id,
          classroom_id: classroomId,
          created_run_id: plan.set.created_run_id,
          AND: [
            { create_state: { path: ['status'], equals: 'FAILED' } },
            { create_state: { path: ['started_at'], equals: previous.started_at } },
          ],
        }
      : { id: plan.set.id, classroom_id: classroomId, created_run_id: null },
    data: { created_run_id: plan.run.id, create_state: toJson(state) },
  });
  if (claimed.count === 0) {
    const now = await prisma.teamSet.findUnique({
      where: { id: plan.set.id },
      select: { create_state: true },
    });
    if (readCreateState(now?.create_state)?.status === 'RUNNING') {
      throw new TeamSetError('create_in_progress', 'Teams for this set are being created now.');
    }
    throw new TeamSetError('already_created', 'Teams were already created from this set.');
  }

  try {
    await tasks.trigger(
      APPLY_TASK_ID,
      { teamSetId: plan.set.id },
      { idempotencyKey: `${APPLY_TASK_ID}:${plan.set.id}:${plan.run.id}:${state.attempt}` }
    );
  } catch (error) {
    console.error(`[teamSet] could not queue create for set ${plan.set.id}`, error);
    await prisma.teamSet.updateMany({
      where: {
        id: plan.set.id,
        created_run_id: plan.run.id,
        create_state: { path: ['started_at'], equals: state.started_at },
      },
      data: previous
        ? { created_run_id: plan.set.created_run_id, create_state: toJson(previous) }
        : { created_run_id: null, create_state: Prisma.DbNull },
    });
    throw new TeamSetError(
      'trigger_unavailable',
      'The create could not be queued; nothing new was created. Try again.'
    );
  }
}

/** The WHERE that matches only this attempt's create, and only while it is RUNNING. */
const whileOursAndRunning = (teamSetId: string, startedAt: string) => ({
  id: teamSetId,
  AND: [
    { create_state: { path: ['status'], equals: 'RUNNING' } },
    { create_state: { path: ['started_at'], equals: startedAt } },
  ],
});

/**
 * Persist progress — but only while the row still holds THIS attempt,
 * RUNNING. A create that was stopped underneath it (canceled, or expired as
 * 'lost') must not be flipped back to RUNNING by a late write; in that case
 * the teams this attempt made are still merged into the stopped state (its
 * status untouched), because a retry can only skip teams it knows exist.
 *
 * Returns false when the create is no longer ours; the caller stops. A
 * database failure is logged (by set id only) and swallowed — the teams it
 * describes exist either way and the next write carries them.
 */
async function writeCreateState(teamSetId: string, state: CreateState): Promise<boolean> {
  const prisma = getPrisma();
  try {
    const { count } = await prisma.teamSet.updateMany({
      where: whileOursAndRunning(teamSetId, state.started_at),
      data: { create_state: toJson(state) },
    });
    if (count > 0) return true;

    const row = await prisma.teamSet.findUnique({
      where: { id: teamSetId },
      select: { create_state: true },
    });
    const current = readCreateState(row?.create_state);
    if (!current || current.started_at !== state.started_at) return false;
    if (current.status === 'RUNNING') return true; // a concurrent write of ours; not stopped
    const known = new Set(current.teams.map(team => team.team_id));
    const extra = state.teams.filter(team => !known.has(team.team_id));
    if (extra.length > 0) {
      const merged: CreateState = { ...current, teams: [...current.teams, ...extra] };
      merged.counts = recount(merged, state.counts?.members_added ?? 0, true);
      await prisma.teamSet.updateMany({
        where: {
          id: teamSetId,
          AND: [
            { create_state: { path: ['status'], equals: current.status } },
            { create_state: { path: ['started_at'], equals: current.started_at } },
          ],
        },
        data: { create_state: toJson(merged) },
      });
    }
    return false;
  } catch (error) {
    console.error(
      `[teamSet] could not record create progress for set ${teamSetId}`,
      error instanceof Error ? error.name : 'unknown'
    );
    return true;
  }
}

/**
 * Mark a RUNNING create FAILED from outside `applyCreate` — the apply task's
 * cancel hook (`canceled`) or its last-resort catch (`internal_error`).
 * Conditional on the row still holding the RUNNING state that was read, so a
 * create that finished (or restarted) meanwhile is left alone, and every team
 * already recorded is kept. Returns whether it wrote.
 */
export async function stopCreate({
  teamSetId,
  reason,
}: {
  teamSetId: string;
  reason: 'canceled' | 'internal_error';
}): Promise<boolean> {
  const prisma = getPrisma();
  const row = await prisma.teamSet.findUnique({
    where: { id: teamSetId },
    select: { create_state: true },
  });
  const state = readCreateState(row?.create_state);
  if (!state || state.status !== 'RUNNING') return false;
  const stopped: CreateState = {
    ...state,
    status: 'FAILED',
    failed: [...state.failed, { team: '*', reason }],
    finished_at: new Date().toISOString(),
  };
  stopped.counts = recount(stopped, state.counts?.members_added ?? 0, true);
  const { count } = await prisma.teamSet.updateMany({
    where: whileOursAndRunning(teamSetId, state.started_at),
    data: { create_state: toJson(stopped) },
  });
  return count > 0;
}

/**
 * Split `addTeamMembers`' `not_found` — which it uses both for "no Classmoji
 * user has this login" and for a GitHub 404 — by checking the logins locally.
 */
async function classifyMemberFailures(
  failures: { login: string; error: string }[]
): Promise<Map<string, CreateMemberFailureReason>> {
  const reasons = new Map<string, CreateMemberFailureReason>();
  const notFound = failures.filter(f => f.error === 'not_found').map(f => f.login);
  const known = new Set<string>();
  if (notFound.length > 0) {
    const users = await getPrisma().user.findMany({
      where: {
        OR: notFound.map(login => ({ login: { equals: login, mode: 'insensitive' as const } })),
      },
      select: { login: true },
    });
    for (const user of users) if (user.login) known.add(user.login.toLowerCase());
  }
  for (const failure of failures) {
    const key = failure.login.toLowerCase();
    if (failure.error === 'not_found') {
      reasons.set(key, known.has(key) ? 'github_user_not_found' : 'no_local_user');
    } else {
      reasons.set(key, failure.error === 'db_error' ? 'db_error' : 'provider_error');
    }
  }
  return reasons;
}

/** A failed team, in the closed vocabulary: a rule refusal keeps its code. */
function teamFailureReason(error: unknown): CreateFailureReason {
  if (error instanceof TeamServiceError) return error.code;
  return isDatabaseError(error) ? 'db_error' : 'provider_error';
}

/**
 * Create the claimed run's teams. Called by the `team-set-apply` task.
 *
 * Ensures the Tag named after the set (and points `tag_id` at it), then, per
 * team in run order: `teamAdmin.createTeam` (visible, tagged, under the name
 * the claim stored) and `teamAdmin.addTeamMembers` by login. A team that fails
 * is recorded and the loop CONTINUES — half a class with teams beats none, and
 * every failure is listed. `create_state` is written after each team so
 * progress is readable while it runs. Ends DONE (every team, every member),
 * PARTIAL (every team exists; some members or tags did not make it) or FAILED
 * (some team does not exist — the same run can be claimed again). Never
 * deletes: not a team, not a tag, not a membership.
 *
 * Idempotent on re-entry: a state that is no longer RUNNING is returned as is,
 * and teams already recorded in `state.teams` are skipped. If the create is
 * stopped underneath it (stopCreate on cancel, or lazy expiry), the next
 * progress write notices, the teams made so far are merged into the stopped
 * state, and no further team is made.
 */
export async function applyCreate({
  teamSetId,
  onProgress,
}: {
  teamSetId: string;
  onProgress?: (state: CreateState) => void;
}): Promise<CreateState> {
  const prisma = getPrisma();
  const set = await prisma.teamSet.findUnique({ where: { id: teamSetId } });
  const initial = readCreateState(set?.create_state);
  if (!set || !set.created_run_id || !initial) {
    throw new TeamSetError('not_found', 'No claimed create for this team set.');
  }
  if (initial.status !== 'RUNNING') return initial;

  const state: CreateState = {
    ...initial,
    failed: [...initial.failed],
    teams: [...initial.teams],
  };
  let membersAdded = initial.counts?.members_added ?? 0;
  /** Write progress; false once the create was stopped underneath us. */
  const report = async (finished = false): Promise<boolean> => {
    state.counts = recount(state, membersAdded, finished);
    const ours = await writeCreateState(set.id, state);
    try {
      onProgress?.(state);
    } catch {
      // A progress callback is advisory; it must not stop a create midway.
    }
    return ours;
  };
  /** The state as stored now — after a stop, that is the stop's state (with our teams merged in). */
  const stored = async (): Promise<CreateState> => {
    const row = await prisma.teamSet.findUnique({
      where: { id: set.id },
      select: { create_state: true },
    });
    return readCreateState(row?.create_state) ?? state;
  };
  const finish = async (status: CreateState['status']) => {
    state.status = status;
    state.finished_at = new Date().toISOString();
    return (await report(true)) ? state : stored();
  };

  try {
    const runRow = await prisma.teamSetRun.findUnique({ where: { id: set.created_run_id } });
    if (!runRow || runRow.status !== 'SOLVED' || !runRow.result) {
      state.failed.push({ team: '*', reason: 'internal_error' });
      return await finish('FAILED');
    }
    const run = toRunRow(runRow);
    const runTeams = run.result!.teams;
    // The names the claim stored — the ones the owner approved. A state
    // claimed before names were stored falls back to computing them.
    const names =
      state.names?.length === runTeams.length
        ? state.names
        : teamNamesFor(
            set.name,
            run.config,
            runTeams,
            await optionLabelsFor(run),
            await classroomTeamSlugs(set.classroom_id, new Set(state.teams.map(t => t.team_id)))
          );
    const teams = runTeams.map((team, i) => ({ ...team, n: i + 1, name: names[i]! }));
    state.total = teams.length;

    let tagId: string;
    try {
      const tag = await organizationTagService.upsert(set.classroom_id, set.name);
      tagId = tag.id;
      if (set.tag_id !== tag.id) {
        await prisma.teamSet.update({ where: { id: set.id }, data: { tag_id: tag.id } });
      }
    } catch (error) {
      console.error(`[teamSet] could not ensure tag for set ${set.id}`, error);
      state.failed.push({ team: '*', reason: 'tag_failed' });
      return await finish('FAILED');
    }

    const users = await prisma.user.findMany({
      where: { id: { in: teams.flatMap(t => t.member_user_ids) } },
      select: { id: true, login: true },
    });
    const loginOf = new Map(users.map(u => [u.id, u.login]));
    const alreadyCreated = createdPositions(state);

    for (const team of teams) {
      if (alreadyCreated.has(team.n)) continue;

      let createdTeam: { id: string; name: string };
      try {
        const created = await teamAdminService.createTeam({
          classroomId: set.classroom_id,
          name: team.name,
          isVisible: true,
          tagIds: [tagId],
        });
        createdTeam = created.team;
        state.teams.push({ team_id: created.team.id, name: created.team.name, n: team.n });
        if (created.tagsFailed.length > 0) {
          state.failed.push({ team: team.name, reason: 'tag_failed' });
        }
      } catch (error) {
        console.error(`[teamSet] could not create team ${team.n} of set ${set.id}`, error);
        state.failed.push({ team: team.name, reason: teamFailureReason(error) });
        state.done += 1;
        if (!(await report())) return await stored();
        continue;
      }

      // The team exists from here on: whatever happens to its members is a
      // member-level failure, never a reason to retry the team itself.
      const memberFailures: NonNullable<CreateFailure['members']> = [];
      const logins: string[] = [];
      const userByLogin = new Map<string, string>();
      for (const userId of team.member_user_ids) {
        const login = loginOf.get(userId) ?? null;
        if (!login) {
          memberFailures.push({ user_id: userId, login: null, reason: 'no_login' });
          continue;
        }
        logins.push(login);
        userByLogin.set(login.toLowerCase(), userId);
      }
      if (logins.length > 0) {
        let failures: { login: string; error: string }[] = [];
        try {
          const added = await teamAdminService.addTeamMembers({
            classroomId: set.classroom_id,
            slugOrId: createdTeam.id,
            logins,
          });
          membersAdded += added.succeeded.length;
          failures = added.failed;
        } catch (error) {
          console.error(
            `[teamSet] could not add members to team ${team.n} of set ${set.id}`,
            error
          );
          const reason = isDatabaseError(error) ? 'db_error' : 'provider_error';
          failures = logins.map(login => ({ login, error: reason }));
        }
        const reasons = await classifyMemberFailures(failures).catch(
          () => new Map<string, CreateMemberFailureReason>()
        );
        for (const failure of failures) {
          const key = failure.login.toLowerCase();
          memberFailures.push({
            user_id: userByLogin.get(key) ?? '',
            login: failure.login,
            reason: reasons.get(key) ?? 'provider_error',
          });
        }
      }
      if (memberFailures.length > 0) {
        state.failed.push({ team: team.name, reason: 'members_failed', members: memberFailures });
      }
      state.done += 1;
      // Stopped underneath (canceled, or expired as lost): make no more teams.
      if (!(await report())) return await stored();
    }

    if (state.teams.length < state.total) return await finish('FAILED');
    return await finish(state.failed.length > 0 ? 'PARTIAL' : 'DONE');
  } catch (error) {
    console.error(`[teamSet] create for set ${set.id} stopped`, error);
    state.failed.push({ team: '*', reason: 'internal_error' });
    return finish('FAILED');
  }
}

// ─── Used by the solve task ─────────────────────────────────────────────────

/** The run and the exact problem JSON the engine reads. Callers check `run.status`. */
export async function loadRunForSolve(
  runId: string
): Promise<{ run: TeamSetRunRow; problem: TeamSetProblem }> {
  const row = await getPrisma().teamSetRun.findUnique({ where: { id: runId } });
  if (!row) throw new TeamSetError('not_found', `Run ${runId} not found.`);
  const run = toRunRow(row);
  return { run, problem: run.problem };
}

/**
 * QUEUED → RUNNING, and only from QUEUED: a run already RUNNING belongs to
 * another delivery of the task, and a finished (or expired) one is left
 * alone. Returns whether this call made the transition.
 */
export async function markRunning(runId: string, triggerRunId: string | null): Promise<boolean> {
  const { count } = await getPrisma().teamSetRun.updateMany({
    where: { id: runId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      started_at: new Date(),
      ...(triggerRunId ? { trigger_run_id: triggerRunId } : {}),
    },
  });
  return count > 0;
}

const CORE_STATUSES: ReadonlySet<string> = new Set(['complete', 'timeout', 'n/a']);
const ENGINE_VERSION = /^[a-z][a-z0-9_-]{0,15}@[0-9A-Za-z._-]{1,24}$/;

/**
 * The optional fields a newer engine adds, each accepted only in its exact
 * shape — they land in the run row, and a malformed line must not put
 * arbitrary text there.
 */
function engineExtras(solver: SolverOutput) {
  const coreStatus =
    typeof solver.core_status === 'string' && CORE_STATUSES.has(solver.core_status)
      ? solver.core_status
      : undefined;
  const engine =
    typeof solver.engine === 'string' && ENGINE_VERSION.test(solver.engine)
      ? solver.engine
      : undefined;
  const s = solver.stats as Partial<SolverStats> | undefined;
  const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const stats =
    s &&
    isCount(s.people) &&
    isCount(s.slots) &&
    isCount(s.pairs) &&
    typeof s.build_s === 'number' &&
    Number.isFinite(s.build_s)
      ? { people: s.people, slots: s.slots, pairs: s.pairs, build_s: s.build_s }
      : undefined;
  return { coreStatus, engine, stats };
}

/**
 * Record the engine's answer.
 *
 * A solution is NOT trusted: it is rescored with `scoreAssignment`, which must
 * agree with the engine's objective exactly and find no violation. Anything
 * else is `score_mismatch` — a disagreement between the two implementations of
 * the objective is a bug, and a proposal nobody can explain must not become
 * teams. INFEASIBLE keeps the engine's unsat core, labelled from the context
 * and the grouping question's option labels, plus one sentence (`summary`)
 * saying what it means; with `core_status: 'timeout'` that sentence says the
 * colliding rules could not be determined in time rather than blaming the
 * structure.
 *
 * `engine` is replaced by the version the engine reports, when it reports
 * one; `core_status` and `stats` are kept in `solver`.
 *
 * A run that is no longer QUEUED/RUNNING (canceled, expired, or already
 * finished by a duplicate delivery) is returned unchanged.
 */
export async function completeRun(runId: string, solver: SolverOutput): Promise<TeamSetRunRow> {
  const prisma = getPrisma();
  const row = await prisma.teamSetRun.findUnique({ where: { id: runId } });
  if (!row) throw new TeamSetError('not_found', `Run ${runId} not found.`);
  if (TERMINAL_STATUSES.has(row.status)) return toRunRow(row);
  const run = toRunRow(row);

  const { coreStatus, engine, stats } = engineExtras(solver);
  const summary: SolverSummary = {
    status: solver.status,
    objective: solver.objective,
    bound: solver.bound,
    wall_s: solver.wall_s,
    ...(coreStatus ? { core_status: coreStatus } : {}),
    ...(stats ? { stats } : {}),
  };
  const finishedAt = new Date();
  const previous = run.diagnostics ?? {};
  const write = (data: Prisma.TeamSetRunUpdateManyMutationInput) =>
    prisma.teamSetRun
      .updateMany({
        where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { ...data, ...(engine ? { engine } : {}) },
      })
      .then(() => prisma.teamSetRun.findUniqueOrThrow({ where: { id: runId } }))
      .then(toRunRow);

  if (solver.status === 'OPTIMAL' || solver.status === 'FEASIBLE') {
    // Empty slots are not teams: the engine should omit them, and if one slips
    // through it must not become an empty GitHub team at create time. The
    // scorer counts only open teams, so dropping them changes no objective.
    const teams = solver.teams
      .filter(team => team.members.length > 0)
      .sort((a, b) => a.slot - b.slot);
    const scored = scoreAssignment(run.problem, teams);
    if (
      solver.objective === null ||
      scored.objective !== solver.objective ||
      scored.violations.length > 0
    ) {
      return write({
        status: 'FAILED',
        error: 'score_mismatch',
        solver: toJson(summary),
        diagnostics: toJson({
          ...previous,
          mismatch: {
            engine_objective: solver.objective,
            scored_objective: scored.objective,
            violations: scored.violations.slice(0, 20),
          },
        } satisfies RunDiagnostics),
        finished_at: finishedAt,
      });
    }

    const result: RunResult = {
      teams: teams.map(team => {
        const optionIndex = run.problem.slots[team.slot]?.option;
        const optionId = optionIndex === undefined ? null : run.context.option_ids[optionIndex];
        return {
          slot: team.slot,
          option_id: run.config.grouping.mode === 'free' || !optionId ? null : optionId,
          member_user_ids: team.members.map(p => run.problem.people[p]!),
        };
      }),
    };
    const { metrics } = computeMetrics(run.problem, run.context, teams);
    return write({
      status: 'SOLVED',
      result: toJson(result),
      metrics: toJson(metrics),
      solver: toJson(summary),
      error: null,
      finished_at: finishedAt,
    });
  }

  if (solver.status === 'INFEASIBLE') {
    const optionLabels = await optionLabelsFor(run);
    const core = [...new Set(Array.isArray(solver.core) ? solver.core : [])]
      .filter((src): src is string => typeof src === 'string')
      .map(src => ({ src, label: labelForSrc(src, run.context, run.problem, optionLabels) }));
    return write({
      status: 'INFEASIBLE',
      solver: toJson(summary),
      diagnostics: toJson({
        ...previous,
        core,
        ...(coreStatus ? { core_status: coreStatus } : {}),
        summary: infeasibleSummary(core.length, coreStatus),
      } satisfies RunDiagnostics),
      finished_at: finishedAt,
    });
  }

  return write({
    status: 'FAILED',
    error: solver.status === 'MODEL_INVALID' ? 'model_invalid' : 'no_solution_in_time',
    solver: toJson(summary),
    finished_at: finishedAt,
  });
}

/** Mark a run FAILED with a closed-vocabulary code (unknown codes become `engine_error`). */
export async function failRun(runId: string, code: string): Promise<void> {
  const error = (TEAM_SET_RUN_ERRORS as readonly string[]).includes(code)
    ? (code as TeamSetRunErrorCode)
    : 'engine_error';
  await getPrisma().teamSetRun.updateMany({
    where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'FAILED', error, finished_at: new Date() },
  });
}
