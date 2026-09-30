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
 * There is no sweeper job. A run still QUEUED past its wait (FAILED
 * 'queue_expired'), a run RUNNING or a create RUNNING far past its task's
 * lifetime (FAILED 'lost') is expired the next time anything reads it; a FAILED
 * create can be claimed again (same run: the teams it made are skipped, and
 * teams it made without recording them are found on the tag by name and
 * adopted; no team made: any run).
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
 * ── Locked once created ─────────────────────────────────────────────────────
 * Once a create is claimed the set is LOCKED (isSetLocked): saves, runs,
 * Discard and another create are refused `set_locked`, except after a FAILED
 * create that made no team, which frees the set again. A set is also held to
 * one unfinished run at a time: startRun refuses `run_in_progress` while a run
 * is QUEUED or RUNNING.
 *
 * ── Who changed what ────────────────────────────────────────────────────────
 * Every save stamps what it adds (stampProvenance): a new pin gets
 * added_by/_via/_at, an option newly Closed gets closed_by/_via/_at, with
 * `via` 'page' or 'mcp'. Can't solve and Setup read "who closed it" from those
 * stamps; a config saved before stamps falls back to the run's starter.
 *
 * ── Identity questions ──────────────────────────────────────────────────────
 * Answers to a question flagged `identity_question` never leave this file tied
 * to a person. Every read that returns answer text per person (notes, the why
 * facts) strips the form's identity mask first (formIdentity.service), which
 * covers flags set after a run was solved. Identity data leaves only as class
 * counts (Setup's answer_counts), per-rule team counts (identity_rules) and,
 * on explicit request, the numbers and names of the teams a rule missed
 * (identityMissedTeams) — never whose answer. The same mask is applied to
 * what a check or an unsolved run names on the way out (withoutMaskedPeople,
 * coreWithoutMaskedPeople): an issue or a Can't-solve item about a masked
 * question carries no person, even when it was stored before the flag. A run
 * that grouped (or placed people) by a question flagged since is stale, so it
 * can't be created, and its views name no option per team or person and no
 * rank (explainRunOf, groupingMasked).
 *
 * ── Names ───────────────────────────────────────────────────────────────────
 * Names are resolved on read, and only for members of the classroom
 * (namesFor): an id that isn't one reads as unnamed. A save refuses a new pin
 * naming someone outside the classroom (`invalid_config`, a count, no names).
 *
 * ── Errors ──────────────────────────────────────────────────────────────────
 * `TeamSetError.code` is a closed vocabulary callers branch on; the message is
 * a fact for logs and agents, and the pages map the code to their own
 * sentence. A run's `error` column is a second closed vocabulary
 * (TEAM_SET_RUN_ERRORS) — never exception text, which would carry Prisma query
 * text or provider internals to a client. Every string a page shows as-is
 * (staleness reasons, preview warnings, check messages, labels) is a fact:
 * counts, labels, names; never advice.
 */
import { createHash, randomUUID } from 'node:crypto';

import { tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import { Prisma } from '@prisma/client';
import type {
  TeamSet as TeamSetDbRow,
  TeamSetRun as TeamSetRunDbRow,
  TeamSetRunStatus,
} from '@prisma/client';

import { getGitHubProvider } from '../git/index.ts';
import {
  FIELD_TYPE_REGISTRY,
  flattenFields,
  isIdentityQuestion,
  withoutAnswers,
  type FormField,
  type FormFieldType,
} from './formContract.ts';
import { fieldsOf } from './form.service.ts';
import { identityMaskForForm } from './formIdentity.service.ts';
import * as organizationTagService from './organizationTag.service.ts';
import * as teamAdminService from './teamAdmin.service.ts';
import { TeamServiceError, isReservedSlug, predictTeamSlug } from './teamAdmin.service.ts';
import { sleep } from './sleep.ts';
import {
  TEAM_SET_JOB_FIELD_TYPES,
  TeamSetConfigSchema,
  TeamSetConfigError,
  applyConfigPatchWithNotes,
  fieldOptions,
  fieldRanks,
  highestPinNumber,
  jobsAllowedFor,
  leftOutNotes,
  normalizeTeamSetName,
  numberedTeamSetName,
  numericBounds,
  parseStoredTeamSetConfig,
  resolveNonRespondents,
  stampProvenance,
  suggestConfig,
  teamSetRuleId,
  configProblemsAgainstForm,
  withoutRetiredKeys,
  type IdentityAnswerCounts,
  type TeamSetConfig,
  type TeamSetConfigPatchInput,
  type TeamSetJob,
  type TeamSetNonRespondents,
  type TeamSetRule,
  type TeamSetStampVia,
} from './teamSetConfig.ts';
import {
  compileProblem,
  parseSrc,
  type CompileInput,
  type TeamSetContext,
  type TeamSetProblem,
  type TeamSetSolveStages,
  type TeamSetSolveStatus,
} from './teamSetProblem.ts';
import { scoreAssignment } from './teamSetScore.ts';
import { runChecks, teamCountRange, type CheckIssue } from './teamSetChecks.ts';
import { minimalFlex } from './teamSetFlex.ts';
import {
  SET_BUSY_RUN_TEXT,
  SET_BUSY_TEXT,
  SET_NAME_EMPTY_TEXT,
  changedSinceRunWarning,
  nameCollisionText,
  namesNotCheckedWarning,
  noLoginWarning,
  pinPeopleOutsideText,
  retryBlockedText,
  staleReasonTexts,
} from './teamSetServiceText.ts';
import {
  computeMetrics,
  metricsView,
  ruleMissedSlots,
  type PersonPlacement,
  type TeamSetMetrics,
  type TeamSetMetricsView,
} from './teamSetMetrics.ts';
import {
  closedProvenance,
  closedProvenanceView,
  compareAssignments,
  coreItems,
  diffConfigs,
  explainLabels,
  infeasibleSummary,
  labelSrc,
  optionStatuses,
  placementFacts,
  ruleMustLabel,
  setStatus,
  teamSignals,
  toPinView,
  type ClosedProvenanceView,
  type CoreItem,
  type CreateProgressView,
  type CreateTeamProgress,
  type ExplainLabels,
  type ExplainRun,
  type OptionRef,
  type OptionStatus,
  type PersonRef,
  type PinView,
  type PlacementFacts,
  type RunComparison,
  type SetupChange,
  type TeamSetStatus,
  type TeamSignals,
} from './teamSetExplain.ts';

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
 * is capped at 300 s, the apply task at 1,800 s.
 *
 * A QUEUED run gets longer because a burst of runs legitimately waits in the
 * solve queue; the same number goes to Trigger as the solve's `ttl`, so the
 * queue drops a run at the moment this file stops waiting for it (and that
 * expiry is `queue_expired`, not `lost`: nothing ever started).
 *
 * A create is expired 35 minutes after its last SIGN OF LIFE, not after its
 * claim: the claim stamps `heartbeat_at`, the apply task stamps it again when
 * it starts (`task_started_at`) and on every progress write. A task that sat
 * in Trigger's queue for twenty minutes therefore still gets its whole
 * 30-minute run before anyone may call it lost.
 */
const RUN_QUEUED_TTL_MS = 15 * 60_000;
const RUN_RUNNING_TTL_MS = 10 * 60_000;
const CREATE_RUNNING_TTL_MS = 35 * 60_000;

/**
 * The set's row lock (SELECT … FOR UPDATE) is held by startRun while it
 * compiles and checks — up to this long, its transaction's limit — and by a
 * save only while it applies and writes. Waiting for the lock counts against
 * a transaction's own limit, so a save gets more than the longest hold: a
 * save that arrives during a long start waits for it instead of failing.
 */
const RUN_LOCK_HOLD_MS = 60_000;
const START_RUN_TX = { maxWait: 10_000, timeout: RUN_LOCK_HOLD_MS } as const;
const SAVE_TX = { maxWait: 10_000, timeout: RUN_LOCK_HOLD_MS + 15_000 } as const;

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

/**
 * The whole GitHub pre-flight (org read, token mint, every name probe) must
 * answer within this: it runs inside an MCP call the connector gives ~60 s.
 * Past it the preview is refused `github_unavailable` (reason 'timeout'),
 * never left hanging. Tests shorten it with `__setPreflightBudgetForTests`.
 */
const PREFLIGHT_BUDGET_MS = 15_000;
let preflightBudgetMs = PREFLIGHT_BUDGET_MS;

/** Tests only: shorten the pre-flight's budget; no argument restores it. */
export const __setPreflightBudgetForTests = (ms?: number): void => {
  preflightBudgetMs = ms ?? PREFLIGHT_BUDGET_MS;
};

/**
 * On a RETRY a name GitHub reports as taken is suffixed and probed again, at
 * most this many rounds (each round only asks about the names it changed).
 */
const NAME_PROBE_ROUNDS = 3;

/** The final create_state write is retried this often (short backoff) before the create throws. */
const TERMINAL_WRITE_ATTEMPTS = 3;
const TERMINAL_WRITE_BACKOFF_MS = 150;

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
  /** The create would make classroom-only teams (github_teams false); only GitHub teams are made. */
  | 'github_teams_off_unsupported'
  | 'trigger_unavailable'
  | 'github_unavailable'
  | 'name_collision'
  /** The classroom's organization is not on GitHub; creating teams is GitHub only. */
  | 'provider_unsupported'
  /**
   * A create was claimed for the set (see isSetLocked): its setup, its runs
   * and its create are fixed. details: `{ run_number, status }` of the create.
   */
  | 'set_locked'
  /** startRun while one of the set's runs is QUEUED or RUNNING. details: `{ run_number }`. */
  | 'run_in_progress'
  /** A new set named like one the form already has. details: `{ name }`. */
  | 'name_taken'
  /**
   * A save waited for the set's row past its time limit (another save or a
   * run's start held it) and wrote nothing.
   */
  | 'set_busy';

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
  /** RUNNING far past the solve task's lifetime; expired on read. */
  'lost',
  /** Still QUEUED when its wait ran out (Trigger's ttl drops it too); never started. */
  'queue_expired',
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
  /** Two-stage solves only (non_respondents 'group'): each stage's own answer. */
  stages?: TeamSetSolveStages;
}

/** `team_set_runs.diagnostics`. */
export interface RunDiagnostics {
  issues?: CheckIssue[];
  /**
   * The engine's core, labelled WITHOUT names (a pin's people are counted):
   * names never enter a run's JSON. describeRun rebuilds the labels on read.
   */
  core?: { src: string; label: string }[];
  /** On INFEASIBLE: see SolverCoreStatus. */
  core_status?: SolverCoreStatus;
  /**
   * On INFEASIBLE: one facts sentence (infeasibleSummary). Runs stored before
   * it was facts-only carry an older sentence; describeRun recomputes it.
   */
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
  /**
   * Only for a problem with a `group` (two-stage solve): each stage's answer.
   * completeRun REQUIRES it for such a problem and checks the scorer's
   * per-stage parts against it.
   */
  stages?: TeamSetSolveStages | null;
}

/**
 * `tag_failed` on a team (not '*') is only in states written before a tag
 * write failure failed the whole team; `teamAdmin.createTeam` now writes the
 * team and its tags together or not at all. '*' `tag_failed` = the set's tag
 * could not be ensured, so no team was attempted.
 */
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
 * some members could not be added — fixed by hand on the Teams screen, never
 * by another create. FAILED: at least one team was not created; the same run
 * can be claimed again and the teams already made are skipped (or, when none
 * were made, another run can be claimed instead).
 */
export interface CreateState {
  status: 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED';
  run_id: string;
  run_number: number;
  total: number;
  done: number;
  failed: CreateFailure[];
  /**
   * `n` is the team's 1-based position in the run's result (absent on rows
   * written before it existed); reads number the teams as the run's views do
   * (shownCreateState). `adopted`: the team was found on the set's tag under
   * its planned name without having been recorded (its attempt died between
   * making it and writing it down); the retry that adopted it re-adds its
   * members, which is idempotent, and then drops the flag. `members_added`
   * (how many of its members are on it) is absent on rows written before it
   * existed.
   */
  teams: {
    team_id: string;
    name: string;
    n?: number;
    adopted?: true;
    members_added?: number;
  }[];
  /**
   * The names planned at claim time, index-aligned with the run's teams.
   * applyCreate uses these rather than recomputing, so a team made elsewhere
   * between the claim and the apply cannot rename anything. Reads list these,
   * `sizes` and `renamed` in the order of the run's views (shownCreateState).
   */
  names?: string[];
  /** Members per team at claim time, index-aligned with `names`, so progress reads never load the run. */
  sizes?: number[];
  /** Teams a retry renamed because their planned name was taken (`n` 1-based). */
  renamed?: { n: number; from: string; to: string }[];
  counts?: CreateCounts;
  /** 1 on the first claim, +1 per retry. For humans; identity is `attempt_id`. */
  attempt?: number;
  /**
   * A fresh id per claim — THE identity of one attempt. It is in the apply
   * task's payload and idempotency key, and every write the create makes is
   * conditional on it, so a task from a released or superseded claim (queued
   * late, or delivered twice) finds a different id and does nothing.
   */
  attempt_id?: string;
  claimed_by: string;
  /** When the claim was made. */
  started_at: string;
  /** When the apply task first touched this attempt (null until then). */
  task_started_at?: string | null;
  /** Last sign of life: the claim, the task's start, each progress write. Lazy expiry counts from here. */
  heartbeat_at?: string;
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
  /**
   * What the engine solved. Its soft counts and team-count groups are sets
   * of people built from answers — an identity question's included (the
   * no-one-alone rule) — so it never leaves the server: no view returns it.
   */
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

/** A set row with where it stands (setStatus) and whether it is locked (isSetLocked). */
export type TeamSetRowView = TeamSetRow & { status: TeamSetStatus; locked: boolean };

/**
 * One set of a form, as the sets list shows it. Times are ISO strings. The
 * last five keys are for callers that read the create columns themselves
 * (the MCP tools' create_status).
 */
export interface TeamSetSummary {
  id: string;
  name: string;
  status: TeamSetStatus;
  run_count: number;
  latest_run: {
    number: number;
    status: TeamSetRunStatus;
    solver_status: TeamSetSolveStatus | null;
    /** From the run's metrics; null until it is solved, and for free teams (no picks). */
    first_choice: number | null;
    responded: number | null;
  } | null;
  /** Set once the create made teams: DONE, PARTIAL, or FAILED part way. */
  created: { run_number: number; teams_created: number; finished_at: string | null } | null;
  updated_at: string;
  form_id: string;
  tag_id: string | null;
  created_run_id: string | null;
  create_state: CreateState | null;
  created_at: string;
}

/** What the poll reads (pollStatus): the latest run, the create, and a signature of both. */
export interface TeamSetStatusPoll {
  latest_run: { number: number; status: TeamSetRunStatus } | null;
  create: CreateProgressView | null;
  /** Changes whenever the latest run or the create moves; opaque. */
  signature: string;
}

export interface RunViewMember {
  user_id: string;
  /** Display name, else login; null when the account has neither. */
  name: string | null;
  login: string | null;
  /** null when not shown: read from an answer to an identity question (shownPlacement). */
  placement: PersonPlacement['placement'] | null;
  /**
   * 1-based rank of the team's option in their answer as submitted; null = not
   * ranked (free mode), or not shown (the grouping question is an identity
   * question now).
   */
  rank: number | null;
  /** A pin in the run's setup names them. */
  pinned: boolean;
  responded: boolean;
  requests_kept: number;
  requests_total: number;
  /** Their own answers to note-rule questions (never an identity question's). */
  notes?: { field_label: string; text: string }[];
}

export interface RunViewTeam {
  /** Position in the view's list: slot order, or by members when the grouping question is masked. */
  n: number;
  name: string;
  /** null in free mode; label null when the option is no longer on the form. */
  option: OptionRef | null;
  size: number;
  /** Empty unless `includePeople`. */
  members: RunViewMember[];
  signals: TeamSignals;
}

/**
 * A check issue as the service hands it to a caller: with `names` resolved
 * from `user_ids` at read time (names are never stored in a run's JSON).
 */
export type NamedCheckIssue = CheckIssue & { names?: string[] };

/** Setup changes since a run; since_run null = there is no run (items empty). */
export interface SetupChanges {
  since_run: number | null;
  items: SetupChange[];
}

/** How a run left one option of the grouping question. */
export type OptionStatusRow = OptionStatus & { option_id: string; label: string | null };

/** One identity rule's aggregate: on how many teams it held. Never which (unless revealed), never whose. */
export interface IdentityRuleView {
  rule_id: string;
  label: string;
  teams_held: number;
  teams_total: number;
  /** Only with `revealIdentity`: the teams it missed on, by number and name. */
  missed_teams?: { n: number; name: string }[];
}

export interface RunView {
  id: string;
  number: number;
  status: TeamSetRunStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  created_by: PersonRef | null;
  /** `gap_pct`: how far the objective is from the proven bound, in percent (0 when OPTIMAL). */
  solver: (SolverSummary & { gap_pct: number | null }) | null;
  /** The pick fields are null for free teams (metricsView). */
  metrics: TeamSetMetricsView | null;
  stale: boolean;
  stale_reasons: string[];
  /** `names` only when the view includes people. */
  issues: NamedCheckIssue[];
  /** INFEASIBLE: the settings that collide, labelled now (names only with people). */
  core: CoreItem[];
  /** INFEASIBLE: the facts sentence (infeasibleSummary), computed on read. */
  summary: string | null;
  /** The set's current setup against this run's. */
  changes_since_run: SetupChange[];
  /** INFEASIBLE: this run's setup against the run before it; null otherwise. */
  changes_from_previous: SetupChanges | null;
  /** Counts for the Running steps. */
  progress: { responses: number; people: number; pins: number; warnings: number };
  identity_rules: IdentityRuleView[];
  /** How the run placed people who didn't answer, and how many there were (roster − responses). */
  non_respondents: { mode: TeamSetNonRespondents; people: number } | null;
  /** Grouped runs only; [] in free mode or without teams. */
  option_status: OptionStatusRow[];
  teams: RunViewTeam[];
}

export interface CreatePreview {
  run_id: string;
  run_number: number;
  tag: { name: string; exists: boolean };
  /** Always true: a create makes a GitHub team per team (classroom-only teams are refused). */
  github_teams: boolean;
  /** The run's team_name_template. */
  name_template: string;
  /** Students across every team. */
  students: number;
  teams: {
    name: string;
    option: OptionRef | null;
    size: number;
    members: { user_id: string; name: string | null; login: string | null }[];
  }[];
  /** Facts about the create (accounts without a GitHub login, names not checked). Never blocks. */
  warnings: string[];
  /** Set when this preview is for retrying a FAILED create of the same run. */
  retry?: { attempt: number; teams_already_created: number };
}

/** One question of the form, as Setup's Questions card shows it. */
export interface SetupQuestionView {
  field_id: string;
  label: string;
  type: FormFieldType;
  type_facts: {
    options?: number;
    ranks?: number;
    min?: number;
    max?: number;
    required?: boolean;
    source?: 'roster' | 'teaching_team';
  };
  identity: boolean;
  help_text: string | null;
  jobs_allowed: TeamSetJob[];
  rules: TeamSetRule[];
  /** The Must sentence per job this question can take (ruleMustLabel); a job missing has no Must. */
  must_labels: Partial<Record<TeamSetJob, string>>;
  counts: {
    answered: number;
    skipped: number;
    requests?: number;
    mutual?: number;
    pitchers?: number;
    class_average?: number | null;
  };
  /** Identity and priority questions: how many students gave each answer (never who). */
  answer_counts?: { option_id: string; label: string; count: number }[];
}

/** One option of the grouping question, as Setup's Projects table shows it. */
export interface SetupOptionView {
  option_id: string;
  label: string;
  description: string | null;
  wanted: { first: number; top3: number };
  runs: 'auto' | 'open' | 'closed';
  /** The option's own size as stored (a partial override); null = none. */
  size: { min: number | null; max: number | null } | null;
  note: string | null;
  /** [] = nobody pitched it. Someone off the roster has no id and no name. */
  pitchers: { user_id: string | null; name: string | null; on_roster: boolean }[];
  pinned_here: { pin_id: string; user_id: string; name: string | null }[];
  closed?: ClosedProvenanceView;
}

/** Everything Setup shows for one set (getSetup). */
export interface SetupView {
  set: {
    id: string;
    name: string;
    status: TeamSetStatus;
    locked: boolean;
    config: TeamSetConfig;
    updated_at: string;
  };
  readiness: {
    roster: number;
    answered: number;
    not_answered: number;
    closes_at: string | null;
    closed: boolean;
  };
  grouping: { mode: 'by_option' | 'free'; field_id: string | null };
  questions: SetupQuestionView[];
  /**
   * `team_count_range`: the team counts at the fewest teams off their size,
   * within the team count, as the capacity check counts them (teamCountRange:
   * sizes per option, closed and forced-open options, a group's own teams);
   * null when those counts have a gap, when none fits, or when there is
   * nobody. Other counts can fit with more teams off their size.
   */
  shape: { people: number; team_count_range: { min: number; max: number } | null };
  non_respondents: {
    /** The stored setting; null = the default. */
    mode: TeamSetNonRespondents | null;
    /**
     * The mode a run would use now: the setting, or its default for this
     * count — a default Group that can't seat the people who didn't answer is
     * Spread (compileProblem).
     */
    resolved: TeamSetNonRespondents;
    count: number;
  };
  pins: PinView[];
  /** Grouped sets only; [] in free mode. */
  options: SetupOptionView[];
  roster: PersonRef[];
  /** Passed checks included (level 'ok'). */
  checks: NamedCheckIssue[];
  changes: SetupChanges;
}

/** compareRuns: the comparison, whether both runs group by a question, and rule labels. */
export type RunComparisonView = RunComparison & {
  /**
   * false when either run makes free teams, or its grouping question is an
   * identity question now (movers are then by teammates).
   */
  grouped: boolean;
  /** Question labels by rule id, for the rule_held rows. */
  rule_labels: Record<string, string>;
};

// ─── Row mapping ────────────────────────────────────────────────────────────

const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Parse a stored config (parseStoredTeamSetConfig): a retired setting is
 * dropped; any other key the schema doesn't know refuses it as
 * `invalid_config` rather than hand it on half-typed — or save it back
 * without what a newer schema added.
 */
function parseStoredConfig(raw: unknown): TeamSetConfig {
  const parsed = parseStoredTeamSetConfig(raw);
  if (!parsed) {
    throw new TeamSetError(
      'invalid_config',
      'This team set’s stored configuration does not match the current config schema.'
    );
  }
  return parsed.config;
}

/**
 * Parse a run's config snapshot to be used as a setup again (Discard): as
 * parseStoredConfig, and a rule, pin or option setting that no longer parses
 * is left out (a top-level setting falls back to its default) instead of
 * failing the whole restore; `left_out` says what.
 */
function parseSnapshotConfig(raw: unknown) {
  const parsed = parseStoredTeamSetConfig(raw, { entries: true });
  if (!parsed) {
    throw new TeamSetError(
      'invalid_config',
      'This run’s setup does not match the current config schema.'
    );
  }
  return parsed;
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

/**
 * A set name as it is stored (normalizeTeamSetName: letters and digits of any
 * script, hyphens, ≤ 40 characters). Human input is normalized, not refused —
 * unless nothing is left of it.
 */
function normalizeSetName(raw: string): string {
  const slug = normalizeTeamSetName(raw);
  if (!slug) {
    throw new TeamSetError('invalid_config', SET_NAME_EMPTY_TEXT, {
      problems: [SET_NAME_EMPTY_TEXT],
      paths: ['name'],
    });
  }
  return slug;
}

/**
 * Map the pure modules' config refusal onto this file's vocabulary. details:
 * `problems` (facts safe to show: labels, never keys or ids) and `paths`
 * (where each is, index-aligned; '' = the setup as a whole).
 */
function asConfigError(error: unknown): never {
  if (error instanceof TeamSetError) throw error;
  if (error instanceof TeamSetConfigError) {
    throw new TeamSetError('invalid_config', error.message, {
      problems: error.problems,
      paths: error.paths,
    });
  }
  throw error;
}

/** Prisma's P2028: an interactive transaction expired or could not start in time. */
const isTransactionTimeout = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2028';

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

/**
 * One attempt's identity: its `attempt_id`, or — on a state written before
 * that existed — its claim time, which was the identity then.
 */
const attemptOf = (state: CreateState): string => state.attempt_id ?? state.started_at;

/** The JSON-path condition that matches exactly this attempt's create_state. */
const attemptWhere = (state: CreateState): Prisma.TeamSetWhereInput =>
  state.attempt_id
    ? { create_state: { path: ['attempt_id'], equals: state.attempt_id } }
    : { create_state: { path: ['started_at'], equals: state.started_at } };

/** The newest sign of life a create's state carries, in ms (NaN when none parses). */
function lastSignOfLife(state: CreateState): number {
  const times = [state.heartbeat_at, state.task_started_at, state.started_at]
    .map(value => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : NaN;
}

/**
 * Whether a set's setup, runs and create are fixed: a create was claimed and
 * has not FAILED without making a team (that frees the set again).
 *   locked ⇔ created_run_id !== null
 *            && !(create_state.status === 'FAILED' && create_state.teams.length === 0)
 */
export function isSetLocked(set: {
  created_run_id: string | null;
  create_state: { status: string; teams?: readonly unknown[] } | null;
}): boolean {
  if (set.created_run_id === null) return false;
  const state = set.create_state;
  return !(state?.status === 'FAILED' && (state.teams?.length ?? 0) === 0);
}

/** Refuse `set_locked` for a set whose create was claimed (see isSetLocked). */
function assertUnlocked(row: Pick<TeamSetDbRow, 'created_run_id' | 'create_state'>): void {
  const state = readCreateState(row.create_state);
  if (!isSetLocked({ created_run_id: row.created_run_id, create_state: state })) return;
  throw new TeamSetError(
    'set_locked',
    state?.status === 'RUNNING' || !state
      ? 'Teams are being created from this set; its setup is fixed.'
      : `Teams were created from run ${state.run_number} of this set; its setup is fixed.`,
    { run_number: state?.run_number ?? null, status: state?.status ?? null }
  );
}

/** A set row with its status and lock. Pass a row already read through expireLostCreate. */
function withStatus(row: TeamSetRow): TeamSetRowView {
  return { ...row, status: setStatus(row), locked: isSetLocked(row) };
}

/**
 * How far a solved run's objective is from the engine's proven bound, in
 * percent of the objective: 0 when OPTIMAL, null when either number is
 * missing (the page rounds it for display).
 */
export function gapPct(solver: Pick<SolverSummary, 'status' | 'objective' | 'bound'> | null) {
  if (!solver) return null;
  if (solver.status === 'OPTIMAL') return 0;
  const { objective, bound } = solver;
  if (typeof objective !== 'number' || typeof bound !== 'number') return null;
  if (!Number.isFinite(objective) || !Number.isFinite(bound)) return null;
  return (Math.max(0, objective - bound) / Math.max(1, Math.abs(objective))) * 100;
}

/**
 * People as views show them: display name, else login; null when the account
 * has neither. Only MEMBERS of the classroom (any role) are named: an id that
 * isn't one — a pin saved with a stray id, someone who has left — reads as
 * unnamed, so no view can turn an arbitrary user id into a name.
 */
async function namesFor(classroomId: string, ids: Iterable<string | null | undefined>) {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string | null>();
  if (unique.length === 0) return names;
  const users = await getPrisma().user.findMany({
    where: { id: { in: unique }, classroom_memberships: { some: { classroom_id: classroomId } } },
    select: { id: true, name: true, login: true },
  });
  for (const user of users) names.set(user.id, user.name?.trim() || user.login || null);
  return names;
}

const personRefOf = (userId: string, names: ReadonlyMap<string, string | null>): PersonRef => ({
  user_id: userId,
  name: names.get(userId) ?? null,
});

/** People sorted by name (unnamed last), then id. */
const byPersonName = (a: PersonRef, b: PersonRef): number => {
  if (a.name !== null && b.name !== null && a.name !== b.name) return a.name.localeCompare(b.name);
  if (a.name !== b.name) return a.name === null ? 1 : -1;
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
};

/** Answer ids of a choice answer (one id, or a list). */
function answerIds(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  return [];
}

/** An answer counts as given when it is not empty. */
function isAnswered(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string') return raw.trim() !== '';
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

/** Everyone a pin names, in the pin's order. */
const pinPeople = (pin: TeamSetConfig['pins'][number]): string[] =>
  pin.kind === 'together' || pin.kind === 'apart' ? pin.user_ids : [pin.user_id];

// ─── Form, roster, responses ────────────────────────────────────────────────

/**
 * The form, scoped to the classroom. A PUBLIC form has no roster and its
 * respondents have no accounts to put on a team, so it is refused here, once,
 * for every entry point.
 */
async function loadForm(classroomId: string, formId: string) {
  const form = await getPrisma().form.findFirst({
    where: { id: formId, classroom_id: classroomId },
    select: {
      id: true,
      title: true,
      access: true,
      status: true,
      closes_at: true,
      current_revision_id: true,
    },
  });
  if (!form) throw new TeamSetError('not_found', 'Form not found in this classroom.');
  if (form.access !== 'CLASSROOM') {
    throw new TeamSetError(
      'form_not_classroom',
      'This form is not a CLASSROOM form; a public form’s respondents are not classroom members.'
    );
  }
  return form;
}

/** The current published revision's fields. An unpublished form has none to configure. */
async function loadCurrentRevision(form: { id: string; current_revision_id: string | null }) {
  if (!form.current_revision_id) {
    throw new TeamSetError('invalid_config', 'This form has not been published.');
  }
  const revision = await getPrisma().formRevision.findUnique({
    where: { id: form.current_revision_id },
    select: { id: true, fields: true },
  });
  if (!revision) throw new TeamSetError('not_found', 'The form’s current revision is missing.');
  return { revisionId: revision.id, fields: fieldsOf(revision.fields) };
}

/**
 * The current revision's fields as a set is checked against them: every
 * question in the form's identity mask (current ∪ draft ∪ older flags,
 * formIdentity.service) flagged as an identity question (flagMasked). A flag
 * saved only in the draft already limits what a set may do with the
 * question — validation, compile, the suggestion and the Setup's jobs all
 * read these fields — so Must, match and mix on it are refused before it is
 * published, and only the no-one-alone job at Off/Prefer is allowed.
 */
async function loadSetFields(form: { id: string; current_revision_id: string | null }) {
  const { revisionId, fields } = await loadCurrentRevision(form);
  // The mask reads every revision of the form: once per call, then passed along.
  const mask = await identityMaskForForm({ formId: form.id });
  return { revisionId, fields: flagMasked(fields, mask), mask };
}

type SetFields = Awaited<ReturnType<typeof loadSetFields>>;

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

/** Every SUBMITTED, identified response, roster or not, sorted by user id. */
async function loadSubmittedResponses(formId: string): Promise<LoadedResponse[]> {
  const rows = await getPrisma().formResponse.findMany({
    where: { form_id: formId, submission_state: 'SUBMITTED', user_id: { not: null } },
    select: { id: true, user_id: true, updated_at: true, answers: true },
  });
  return rows
    .filter((row): row is typeof row & { user_id: string } => Boolean(row.user_id))
    .map(row => ({
      id: row.id,
      user_id: row.user_id,
      updated_at: row.updated_at,
      answers: (row.answers ?? {}) as Record<string, unknown>,
    }))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
}

/** SUBMITTED, identified responses of roster members, sorted by user id. */
async function loadRosterResponses(formId: string, roster: Set<string>): Promise<LoadedResponse[]> {
  return (await loadSubmittedResponses(formId)).filter(row => roster.has(row.user_id));
}

/**
 * How many roster responses gave each answer of each identity question: the
 * counts suggestConfig picks default protected answers from. Counts only.
 */
function identityAnswerCounts(
  fields: FormField[],
  responses: { answers: Record<string, unknown> }[]
): Record<string, IdentityAnswerCounts> {
  const counts: Record<string, IdentityAnswerCounts> = {};
  for (const field of fields) {
    if (!isIdentityQuestion(field)) continue;
    const entry: IdentityAnswerCounts = { answered: 0, byOption: {} };
    for (const response of responses) {
      const ids = answerIds(response.answers[field.id]);
      if (ids.length === 0) continue;
      entry.answered += 1;
      for (const id of new Set(ids)) entry.byOption[id] = (entry.byOption[id] ?? 0) + 1;
    }
    counts[field.id] = entry;
  }
  return counts;
}

/** The suggestion for a form, with identity defaults from the roster's answers. */
async function suggestionFor(
  classroomId: string,
  form: { id: string; title: string },
  fields: FormField[]
) {
  if (!fields.some(field => isIdentityQuestion(field))) return suggestConfig(fields, form.title);
  const roster = new Set(await loadRosterUserIds(classroomId));
  const identityCounts = identityAnswerCounts(fields, await loadRosterResponses(form.id, roster));
  return suggestConfig(fields, form.title, { identityCounts });
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
 * retry. CREATE_RUNNING_TTL_MS after its last sign of life (see there) it is
 * FAILED 'lost' — persisted, and only if the row still holds the very state
 * that was judged (same attempt, still RUNNING, same heartbeat), so a create
 * that finished, restarted or just wrote progress meanwhile is untouched.
 */
async function expireLostCreate(row: TeamSetDbRow): Promise<TeamSetDbRow> {
  const state = readCreateState(row.create_state);
  if (!state || state.status !== 'RUNNING') return row;
  const alive = lastSignOfLife(state);
  if (Number.isFinite(alive) && Date.now() - alive <= CREATE_RUNNING_TTL_MS) return row;

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
        attemptWhere(state),
        ...(state.heartbeat_at
          ? [{ create_state: { path: ['heartbeat_at'], equals: state.heartbeat_at } }]
          : []),
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
 * Fail every QUEUED/RUNNING run matching `where` that has outlived its wait:
 * QUEUED too long is `queue_expired` (it never started — Trigger's ttl drops
 * it at the same age), RUNNING too long is `lost`. The age test is in the
 * WHERE, not decided beforehand, so a run that a solve task just picked up
 * (RUNNING, started a moment ago) can never be expired by a reader that saw it
 * QUEUED.
 */
async function expireLostRuns(where: Prisma.TeamSetRunWhereInput): Promise<void> {
  const now = Date.now();
  const prisma = getPrisma();
  await prisma.teamSetRun.updateMany({
    where: {
      AND: [where, { status: 'QUEUED', created_at: { lt: new Date(now - RUN_QUEUED_TTL_MS) } }],
    },
    data: { status: 'FAILED', error: 'queue_expired', finished_at: new Date(now) },
  });
  await prisma.teamSetRun.updateMany({
    where: {
      AND: [where, { status: 'RUNNING', started_at: { lt: new Date(now - RUN_RUNNING_TTL_MS) } }],
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
        OR: [{ id: setRef }, { name: setRef }, { name: normalizeTeamSetName(setRef) }],
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
  throw new TeamSetError('not_found', 'This form has several team sets.', {
    reason: 'ambiguous',
    names: rows.map(r => r.name),
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Whether a stored setup snapshot makes free teams (no grouping question). */
const isFreeSnapshot = (config: unknown): boolean =>
  (config as { grouping?: { mode?: unknown } } | null)?.grouping?.mode === 'free';

/**
 * The small numbers a run's metrics JSON carries, read defensively.
 * `first_choice` is null for free teams (nobody's pick is counted there).
 */
function metricCounts(
  raw: unknown,
  free: boolean
): { first_choice: number | null; responded: number | null } {
  const metrics = raw as { first_choice?: unknown; responded?: unknown } | null;
  const count = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
  return {
    first_choice: free ? null : count(metrics?.first_choice),
    responded: count(metrics?.responded),
  };
}

/** A stored solver summary's status, when it has one. */
const solverStatusOf = (raw: unknown): TeamSetSolveStatus | null =>
  (raw as { status?: TeamSetSolveStatus } | null)?.status ?? null;

/** The form's sets, oldest first, with where each stands and its latest run. */
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
        select: { number: true, status: true, solver: true, metrics: true, config: true },
      },
    },
  });
  return Promise.all(
    rows.map(async row => {
      const current = await expireLostCreate(row);
      const state = readCreateState(current.create_state);
      const latest = row.runs[0];
      return {
        id: row.id,
        name: row.name,
        status: setStatus({ created_run_id: current.created_run_id, create_state: state }),
        run_count: row._count.runs,
        latest_run: latest
          ? {
              number: latest.number,
              status: latest.status,
              solver_status: solverStatusOf(latest.solver),
              ...metricCounts(latest.metrics, isFreeSnapshot(latest.config)),
            }
          : null,
        created:
          current.created_run_id && state && state.status !== 'RUNNING' && state.teams.length > 0
            ? {
                run_number: state.run_number,
                teams_created: state.teams.length,
                finished_at: state.finished_at,
              }
            : null,
        updated_at: current.updated_at.toISOString(),
        form_id: row.form_id,
        tag_id: current.tag_id,
        created_run_id: current.created_run_id,
        create_state: state,
        created_at: row.created_at.toISOString(),
      };
    })
  );
}

/** A set by id or name (or the form's only set), with its status and lock. */
export async function getSet({
  classroomId,
  formId,
  setRef,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
}): Promise<TeamSetRowView | null> {
  await loadForm(classroomId, formId);
  const row = await resolveSetRow(classroomId, formId, setRef);
  return row ? withStatus(await toShownSetRow(await expireLostCreate(row))) : null;
}

export async function suggestForForm({
  classroomId,
  formId,
}: {
  classroomId: string;
  formId: string;
}): Promise<{ name: string; config: TeamSetConfig }> {
  const form = await loadForm(classroomId, formId);
  const { fields } = await loadSetFields(form);
  return suggestionFor(classroomId, form, fields);
}

/**
 * What a page polls while a run or a create moves: the latest run's number
 * and status, the create's progress, and a signature that changes whenever
 * either does. Light: two small reads (plus names for the create), and the
 * same lazy expiry every read applies.
 */
export async function pollStatus({
  classroomId,
  teamSetId,
}: {
  classroomId: string;
  teamSetId: string;
}): Promise<TeamSetStatusPoll> {
  const row = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  await expireLostRuns({ team_set_id: row.id });
  const latest = await getPrisma().teamSetRun.findFirst({
    where: { team_set_id: row.id },
    orderBy: { number: 'desc' },
    select: { number: true, status: true },
  });
  const state = readCreateState(row.create_state);
  const create = state ? await createProgress(row, state) : null;
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        run: latest,
        create: state && {
          status: state.status,
          attempt: attemptOf(state),
          done: state.done,
          teams: state.teams.length,
          failed: state.failed.length,
          heartbeat: state.heartbeat_at ?? null,
          finished: state.finished_at,
        },
      })
    )
    .digest('hex')
    .slice(0, 16);
  return { latest_run: latest ?? null, create, signature };
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
  const problems = configProblemsAgainstForm(config, fields);
  if (problems.length > 0) {
    throw new TeamSetError('invalid_config', problems.map(problem => problem.text).join(' '), {
      problems: problems.map(problem => problem.text),
      paths: problems.map(problem => problem.path),
    });
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
  const setFields = await loadSetFields(form);
  const { fields } = setFields;

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
    const suggestion = await suggestionFor(classroomId, form, fields);
    base = suggestion.config;
    newName = newName ?? normalizeSetName(suggestion.name);
  }
  return { form, fields, setFields, existing, base, name: existing?.name ?? newName! };
}

/**
 * Stamp what a save adds (see stampProvenance): `before` is the config it
 * replaces, null for a new set (everything in it is then the saver's).
 */
function stamped(
  before: TeamSetConfig | null,
  after: TeamSetConfig,
  userId: string,
  via: TeamSetStampVia
): TeamSetConfig {
  try {
    return stampProvenance(before, after, { user_id: userId, via, at: new Date().toISOString() });
  } catch (error) {
    asConfigError(error);
  }
}

/**
 * Change a set's config under its row lock. `build` gets the config as it is
 * stored NOW — read under the lock — and returns the one to write, so two
 * saves at once apply one after the other and neither loses what the other
 * added (a pin, a Closed option, a stamp). The lock is re-checked there too: a
 * create claimed between the caller's read and this write wins, and the save
 * is refused `set_locked` rather than landing on a created set.
 */
async function updateConfigLocked(
  setId: string,
  build: (
    current: TeamSetConfig,
    tx: Prisma.TransactionClient
  ) => Promise<{ config: TeamSetConfig; notes: string[] }>
): Promise<{ row: TeamSetDbRow; notes: string[] }> {
  try {
    return await getPrisma().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM team_sets WHERE id = ${setId} FOR UPDATE`;
      const stored = await tx.teamSet.findUniqueOrThrow({
        where: { id: setId },
        select: { config: true, created_run_id: true, create_state: true },
      });
      assertUnlocked(stored);
      const current = await withPinNumbering(tx, setId, parseStoredConfig(stored.config));
      const { config, notes } = await build(current, tx);
      const row = await tx.teamSet.update({
        where: { id: setId },
        data: { config: toJson(withoutRetiredKeys(config)) },
      });
      return { row, notes };
    }, SAVE_TX);
  } catch (error) {
    // Prisma's transaction ran out of time (or couldn't start): nothing was written.
    if (isTransactionTimeout(error)) throw new TeamSetError('set_busy', SET_BUSY_TEXT);
    throw error;
  }
}

/**
 * A config saved before pin numbering was stored (no `last_pin_number`),
 * with it set from the highest `pN` in the config and in every run
 * snapshot of the set, so a new pin never takes the id of a pin a run's
 * setup had (its `pin:pN` srcs and the setup diffs pair pins by id). A
 * config that has it is returned as it is.
 */
async function withPinNumbering(
  db: Pick<Prisma.TransactionClient, 'teamSetRun'>,
  setId: string,
  config: TeamSetConfig
): Promise<TeamSetConfig> {
  if (config.last_pin_number !== undefined) return config;
  const runs = await db.teamSetRun.findMany({
    where: { team_set_id: setId },
    select: { config: true },
  });
  let highest = highestPinNumber(config);
  for (const run of runs) {
    const snapshot = run.config as { pins?: unknown; last_pin_number?: unknown } | null;
    const pins = Array.isArray(snapshot?.pins)
      ? snapshot.pins.filter(
          (pin): pin is { id: string } => typeof (pin as { id?: unknown } | null)?.id === 'string'
        )
      : [];
    const last = Number.isSafeInteger(snapshot?.last_pin_number)
      ? (snapshot!.last_pin_number as number)
      : undefined;
    highest = Math.max(
      highest,
      highestPinNumber({
        pins: pins as TeamSetConfig['pins'],
        ...(last !== undefined ? { last_pin_number: last } : {}),
      })
    );
  }
  return highest > 0 ? { ...config, last_pin_number: highest } : config;
}

/** Everyone the pins of `after` name that are not in `before` (by pin id), each once. */
function newPinUserIds(before: TeamSetConfig | null, after: TeamSetConfig): string[] {
  const known = new Set(before?.pins.map(pin => pin.id) ?? []);
  return [...new Set(after.pins.filter(pin => !known.has(pin.id)).flatMap(pinPeople))];
}

/** New pins naming people who aren't members of the classroom, as a config problem (a count, no names). */
async function pinPeopleProblem(
  db: Pick<Prisma.TransactionClient, 'classroomMembership'>,
  classroomId: string,
  before: TeamSetConfig | null,
  after: TeamSetConfig
): Promise<string | null> {
  const userIds = newPinUserIds(before, after);
  if (userIds.length === 0) return null;
  const rows = await db.classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: { in: userIds } },
    select: { user_id: true },
  });
  const members = new Set(rows.map(row => row.user_id));
  const outside = userIds.filter(id => !members.has(id)).length;
  return outside === 0 ? null : pinPeopleOutsideText(outside);
}

/**
 * Refuse `invalid_config` when a pin this save adds names someone who is not
 * a member of the classroom. Pins already in the setup (or brought back from
 * a run, or copied from another set of this form) are not checked again: a
 * student who has since left is the checks' `pin_people_missing`, not a
 * refusal.
 */
async function assertPinPeopleInClassroom(
  db: Pick<Prisma.TransactionClient, 'classroomMembership'>,
  classroomId: string,
  before: TeamSetConfig | null,
  after: TeamSetConfig
): Promise<void> {
  const problem = await pinPeopleProblem(db, classroomId, before, after);
  if (problem) {
    throw new TeamSetError('invalid_config', problem, { problems: [problem], paths: ['pins'] });
  }
}

/** `base-2`, `base-3`, … (numberedTeamSetName): the first name no set on the form has. */
function nextFreeSetName(base: string, taken: ReadonlySet<string>): string {
  for (let k = 2; ; k++) {
    const name = numberedTeamSetName(base, k);
    if (!taken.has(name)) return name;
  }
}

/** A new set named like one the form already has. */
const nameTaken = (name: string): TeamSetError =>
  new TeamSetError('name_taken', `A team set named "${name}" already exists on this form.`, {
    name,
  });

/**
 * Apply a patch, keeping the pure module's `notes` — what the patch did
 * beyond what it said (e.g. option settings dropped with a changed grouping
 * question), which a caller should relay.
 */
function patched(
  base: TeamSetConfig,
  patch: TeamSetConfigPatchInput | undefined,
  fields: FormField[]
): { config: TeamSetConfig; notes: string[] } {
  try {
    if (!patch) return { config: parseStoredConfig(base), notes: [] };
    // A patch may still send a retired setting; it is never kept.
    const result = applyConfigPatchWithNotes(base, patch, fields);
    return { config: withoutRetiredKeys(result.config), notes: result.notes };
  } catch (error) {
    asConfigError(error);
  }
}

/**
 * Create or update a set's config (see resolveBase for which set). A new set
 * starts from `suggestForForm`'s config, then the patch applies. `notes` is
 * what the patch did beyond what it said; relay it.
 *
 * An existing set's patch is applied under its row lock to the config as
 * stored then (updateConfigLocked), so overlapping saves all land. What the
 * save adds is stamped with `userId` and `via` (a new pin's added_by, an
 * option newly Closed's closed_by; stampProvenance). Refused: `set_locked`
 * for a set whose create was claimed (isSetLocked); `invalid_config` for a
 * new pin naming someone outside the classroom; `name_taken` when a new set's
 * name was taken meanwhile.
 */
export async function saveConfig({
  classroomId,
  formId,
  setRef,
  name,
  patch,
  userId,
  via = 'page',
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
  name?: string;
  /** Raw or parsed; applyConfigPatch validates it either way. */
  patch?: TeamSetConfigPatchInput;
  userId: string;
  /** Where the save came from, for the stamps: the Teams page or an MCP tool. */
  via?: TeamSetStampVia;
}): Promise<TeamSetRowView & { notes: string[] }> {
  const {
    fields,
    existing,
    base,
    name: newName,
  } = await resolveBase(classroomId, formId, {
    ...(setRef !== undefined ? { setRef } : {}),
    ...(name !== undefined ? { name } : {}),
  });
  if (existing) {
    assertUnlocked(await expireLostCreate(existing));
    // The patch applies to the config as stored under the lock, not to the
    // one read above: a save that landed meanwhile is kept.
    const { row, notes } = await updateConfigLocked(existing.id, async (current, tx) => {
      const { config: next, notes } = patched(current, patch, fields);
      const config = stamped(current, next, userId, via);
      assertConfigFitsForm(config, fields);
      await assertPinPeopleInClassroom(tx, classroomId, current, config);
      return { config, notes };
    });
    return { ...withStatus(await toShownSetRow(row)), notes };
  }

  const { config: next, notes } = patched(base, patch, fields);
  const config = stamped(null, next, userId, via);
  assertConfigFitsForm(config, fields);
  await assertPinPeopleInClassroom(getPrisma(), classroomId, null, config);

  try {
    const created = await getPrisma().teamSet.create({
      data: {
        classroom_id: classroomId,
        form_id: formId,
        name: newName!,
        config: toJson(config),
        created_by: userId,
      },
    });
    return { ...withStatus(toSetRow(created)), notes };
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(newName!);
    throw error;
  }
}

/**
 * Discard: put a set's setup back to the one a run was solved with. The
 * run's snapshot must still fit the current form (`invalid_config` /
 * `no_grouping_field` otherwise). Pins and Closed options the snapshot brings
 * back keep the stamps they carry; any without one is stamped with `userId`.
 * The snapshot's non_respondents is explicit, so the setting stops following
 * the team size's default. Pin numbering keeps counting from the higher of
 * the two setups, so a pin added after the restore never takes an id a
 * removed pin had. Refused `set_locked` for a created set.
 *
 * A snapshot saved under an earlier schema still restores (parseSnapshotConfig):
 * a setting since retired is dropped, a rule, pin or option setting that no
 * longer parses is left out, and a top-level setting that doesn't falls back
 * to its default; `notes` says what (leftOutNotes), for the caller to relay.
 * It is written under the set's row lock.
 */
export async function revertToRun({
  classroomId,
  teamSetId,
  runRef,
  userId,
  via = 'page',
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
  userId: string;
  via?: TeamSetStampVia;
}): Promise<TeamSetRowView & { notes: string[] }> {
  const set = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  assertUnlocked(set);
  const run = await getRun({ classroomId, teamSetId: set.id, runRef });
  const form = await loadForm(classroomId, set.form_id);
  const { fields } = await loadSetFields(form);

  // Read leniently: a snapshot saved under an earlier schema still restores.
  const { config: snapshot, left_out } = parseSnapshotConfig(run.config);
  const notes = leftOutNotes(run.number, left_out, fields);
  const { row } = await updateConfigLocked(set.id, async current => {
    const lastPin = Math.max(highestPinNumber(current), highestPinNumber(snapshot));
    const restored: TeamSetConfig =
      lastPin > 0 ? { ...snapshot, last_pin_number: lastPin } : snapshot;
    const config = stamped(current, restored, userId, via);
    assertConfigFitsForm(config, fields);
    return { config, notes };
  });
  return { ...withStatus(await toShownSetRow(row)), notes };
}

/**
 * "Start a new set from this setup": a new set on the same form with a copy
 * of another set's config — rules, pins, option settings and notes. Every pin
 * and Closed option in the copy is stamped as `userId`'s (the copy is theirs
 * from here). The copy must fit the current form. Name: `name` when given
 * (refused `name_taken` when the form already has a set by that name),
 * else `{source}-2`, `-3`, … the first that is free. The source may be
 * created (locked); the copy never is.
 */
export async function newSetFromSetup({
  classroomId,
  formId,
  fromSetRef,
  name,
  userId,
  via = 'page',
}: {
  classroomId: string;
  formId: string;
  fromSetRef: string;
  name?: string;
  userId: string;
  via?: TeamSetStampVia;
}): Promise<TeamSetRowView> {
  const form = await loadForm(classroomId, formId);
  const { fields } = await loadSetFields(form);
  const source = await resolveSetRow(classroomId, formId, fromSetRef);
  if (!source) throw new TeamSetError('not_found', 'Team set not found on this form.');

  const config = stamped(null, parseStoredConfig(source.config), userId, via);
  assertConfigFitsForm(config, fields);

  const prisma = getPrisma();
  const taken = new Set(
    (
      await prisma.teamSet.findMany({
        where: { classroom_id: classroomId, form_id: formId },
        select: { name: true },
      })
    ).map(row => row.name)
  );
  let setName: string;
  if (name !== undefined) {
    setName = normalizeSetName(name);
    if (taken.has(setName)) throw nameTaken(setName);
  } else {
    setName = nextFreeSetName(source.name, taken);
  }

  try {
    const created = await prisma.teamSet.create({
      data: {
        classroom_id: classroomId,
        form_id: formId,
        name: setName,
        config: toJson(config),
        created_by: userId,
      },
    });
    return withStatus(toSetRow(created));
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(setName);
    throw error;
  }
}

// ─── Inputs, checks, runs ───────────────────────────────────────────────────

/**
 * Everything a compile needs, plus the staleness snapshot of exactly that.
 * `config` is accepted for the contract's shape; the population rule it
 * carries (`non_respondents`) is applied by compileProblem, which gets both the
 * roster and the responses. The fields carry the form's identity mask
 * (loadSetFields), so a draft-only flag counts in the checks and the compile;
 * `mask` is that mask, for the caller's own reads. `setFields`: the form's
 * fields and mask when the caller has read them already (the form then is
 * one it resolved in this classroom).
 */
export async function loadInputs({
  classroomId,
  formId,
  setFields,
}: {
  classroomId: string;
  formId: string;
  config?: TeamSetConfig;
  setFields?: SetFields;
}): Promise<{
  fields: FormField[];
  revisionId: string;
  responses: CompileInput['responses'];
  roster: CompileInput['roster'];
  snapshot: RunInputs;
  mask: ReadonlySet<string>;
}> {
  const { revisionId, fields, mask } =
    setFields ?? (await loadSetFields(await loadForm(classroomId, formId)));
  const rosterIds = await loadRosterUserIds(classroomId);
  const responses = await loadRosterResponses(formId, new Set(rosterIds));
  return inputsOf({ revisionId, fields, mask }, rosterIds, responses);
}

type LoadedInputs = Awaited<ReturnType<typeof loadInputs>>;

/** loadInputs' result from rows a caller has already read (roster responses only). */
function inputsOf(
  { revisionId, fields, mask }: SetFields,
  rosterIds: string[],
  responses: LoadedResponse[]
): LoadedInputs {
  return {
    fields,
    mask,
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

/**
 * What a config problem's path points at, as a check issue's references: a
 * rule's src, pins' srcs, options' ids (see TeamSetConfigProblem.path).
 */
function problemRefs(path: string): Pick<CheckIssue, 'srcs' | 'option_ids'> {
  const [head, rest = ''] = path.split(/\.(.*)/s, 2);
  const ids = (rest.split('.')[0] ?? '').split(',').filter(Boolean);
  if (head === 'rules' && ids.length > 0) return { srcs: ids };
  if (head === 'pins' && ids.length > 0) return { srcs: ids.map(id => `pin:${id}`) };
  if (head === 'options' && ids.length > 0) return { option_ids: ids };
  return {};
}

/**
 * A config that no longer fits the (republished) form, as check issues: the
 * problem's text, and what it points at as srcs / option_ids.
 */
function configIssues(config: TeamSetConfig, fields: FormField[]): CheckIssue[] {
  try {
    assertConfigFitsForm(config, fields);
    return [];
  } catch (error) {
    if (!(error instanceof TeamSetError)) throw error;
    const details = error.details as { problems?: string[]; paths?: string[] } | undefined;
    const problems = details?.problems ?? [error.message];
    return problems.map((message, i) => ({
      level: 'error' as const,
      code: error.code,
      message,
      ...problemRefs(details?.paths?.[i] ?? ''),
    }));
  }
}

/**
 * Compile a config against the form's current responses and run the checks.
 * `includePassed` adds the checks that passed (level 'ok'), for Setup and
 * checkPatch; a run never stores them.
 */
async function compileFor({
  classroomId,
  formId,
  setName,
  config,
  seed,
  includePassed = false,
  inputs: preloaded,
}: {
  classroomId: string;
  formId: string;
  setName: string;
  config: TeamSetConfig;
  seed: number;
  includePassed?: boolean;
  /** The form's inputs when the caller has read them already. */
  inputs?: LoadedInputs;
}) {
  const inputs = preloaded ?? (await loadInputs({ classroomId, formId, config }));
  return compileLoaded({ setName, config, seed, includePassed, inputs });
}

/**
 * compileFor over inputs already read: pure (no database), so a caller can
 * run it while it holds the set's row lock.
 */
function compileLoaded({
  setName,
  config,
  seed,
  includePassed = false,
  inputs,
}: {
  setName: string;
  config: TeamSetConfig;
  seed: number;
  includePassed?: boolean;
  inputs: LoadedInputs;
}) {
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
    issues: runChecks(compiled.problem, compiled.context, {
      config,
      fields: inputs.fields,
      ...(includePassed ? { includePassed: true } : {}),
    }),
    compiled,
  };
}

const compileSet = (set: TeamSetDbRow, seed: number, includePassed = false) =>
  compileFor({
    classroomId: set.classroom_id,
    formId: set.form_id,
    setName: set.name,
    config: parseStoredConfig(set.config),
    seed,
    includePassed,
  });

/**
 * The mode a run of `config` would use now for people who didn't answer:
 * the setting, or its default for this count. Only an unset setting on teams
 * of two depends on the count — a default Group that can't seat them, or
 * that leaves the people who answered too few teams, is Spread
 * (compileProblem) — so only then are the form's inputs read and the config
 * compiled. A config that doesn't compile gets the plain default.
 * `setFields`: the form's current fields and mask when the caller has them.
 */
async function effectiveNonRespondents(
  set: Pick<TeamSetDbRow, 'classroom_id' | 'form_id' | 'name'>,
  config: TeamSetConfig,
  setFields?: SetFields
): Promise<TeamSetNonRespondents> {
  const plain = resolveNonRespondents(config);
  if (config.non_respondents !== undefined || plain !== 'group') return plain;
  try {
    const loaded = await loadInputs({
      classroomId: set.classroom_id,
      formId: set.form_id,
      ...(setFields ? { setFields } : {}),
    });
    if (configIssues(config, loaded.fields).length > 0) return plain;
    return compileProblem({
      setName: set.name,
      config,
      fields: loaded.fields,
      responses: loaded.responses,
      roster: loaded.roster,
      seed: 0,
    }).non_respondents;
  } catch (error) {
    if (error instanceof TeamSetError || error instanceof TeamSetConfigError) return plain;
    throw error;
  }
}

/**
 * How a set places people who didn't answer: the stored setting (null = the
 * default) and the mode a run would use now (effectiveNonRespondents).
 */
export async function nonRespondentsFor({
  classroomId,
  teamSetId,
}: {
  classroomId: string;
  teamSetId: string;
}): Promise<{ setting: TeamSetNonRespondents | null; resolved: TeamSetNonRespondents }> {
  const set = await findSetScoped(classroomId, teamSetId);
  const config = parseStoredConfig(set.config);
  return {
    setting: config.non_respondents ?? null,
    resolved: await effectiveNonRespondents(set, config),
  };
}

/** How many people an issue names at most; the ids stay complete. */
const MAX_ISSUE_NAMES = 50;

/** The question a src is about when it is a rule's (its per-person part dropped); else null. */
function srcFieldId(src: string): string | null {
  const parsed = parseSrc(src);
  return parsed.kind === 'rule' ? parsed.field_id : null;
}

/**
 * Issues with no person on any about a question in the form's identity mask
 * (current ∪ draft ∪ older flags): its `user_ids` and `names` are dropped.
 * A run stored before a question was flagged — or checked while the flag was
 * only in the draft — may hold such an issue; this is applied on the way
 * out, whatever the run's own context says.
 */
function withoutMaskedPeople<T extends CheckIssue & { names?: string[] }>(
  issues: T[],
  mask: ReadonlySet<string>
): T[] {
  if (mask.size === 0) return issues;
  return issues.map(issue => {
    if (!issue.user_ids && !issue.names) return issue;
    const masked = (issue.srcs ?? []).some(src => {
      const fieldId = srcFieldId(src);
      return fieldId !== null && mask.has(fieldId);
    });
    if (!masked) return issue;
    const { user_ids: _ids, names: _names, ...rest } = issue;
    return rest as T;
  });
}

/**
 * Can't-solve items with no person on a rule of a question in the identity
 * mask: `people` and `user_ids` are dropped (the rule-only label stays).
 */
function coreWithoutMaskedPeople(items: CoreItem[], mask: ReadonlySet<string>): CoreItem[] {
  if (mask.size === 0) return items;
  return items.map(item => {
    if (item.kind !== 'rule' || (!item.people && !item.user_ids)) return item;
    const fieldId = item.link.field_id ?? srcFieldId(item.src);
    if (fieldId === null || !mask.has(fieldId)) return item;
    const { people: _people, user_ids: _ids, ...rest } = item;
    return rest;
  });
}

/**
 * Add `names` to issues that carry `user_ids`, resolved now from User rows of
 * the classroom's members (display name, else login). Names are never stored
 * in a run's JSON — the engine and the row see ids only — so this happens on
 * the way out, and only for callers that already show people. Issues about a
 * question in the identity mask lose their people first (withoutMaskedPeople).
 */
async function nameIssues(
  classroomId: string,
  issues: CheckIssue[],
  mask: ReadonlySet<string>
): Promise<NamedCheckIssue[]> {
  const kept = withoutMaskedPeople(issues, mask);
  const ids = [...new Set(kept.flatMap(issue => issue.user_ids ?? []))];
  if (ids.length === 0) return kept;
  const nameOf = await namesFor(classroomId, ids);
  return kept.map(issue => {
    if (!issue.user_ids?.length) return issue;
    const names = issue.user_ids
      .slice(0, MAX_ISSUE_NAMES)
      .map(id => nameOf.get(id))
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? { ...issue, names } : issue;
  });
}

/** The checks on a set's saved setup; `includePassed` adds the ones that passed (level 'ok'). */
export async function checkSet({
  classroomId,
  teamSetId,
  includePassed = false,
}: {
  classroomId: string;
  teamSetId: string;
  includePassed?: boolean;
}): Promise<NamedCheckIssue[]> {
  const set = await findSetScoped(classroomId, teamSetId);
  const { issues, inputs } = await compileSet(set, 0, includePassed);
  return nameIssues(classroomId, issues, inputs.mask);
}

/**
 * Check a patch WITHOUT saving it: apply it in memory to the set's saved
 * config (or, when there is no set yet — or `newSet` — to the form's
 * suggestion), compile against the current responses and run the checks.
 * Writes nothing: no set is created, no config changes, no run is inserted.
 *
 * A patch that does not parse is refused (`invalid_config`) exactly as
 * saveConfig refuses it; a config that parses but does not fit the form — or
 * a new pin naming someone outside the classroom, which saveConfig refuses —
 * comes back as error-level issues, like every other blocking problem.
 */
export async function checkPatch({
  classroomId,
  formId,
  setRef,
  name,
  newSet,
  patch,
  includePassed = false,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
  name?: string;
  newSet?: boolean;
  patch?: TeamSetConfigPatchInput;
  /** Add the checks that passed (level 'ok'). */
  includePassed?: boolean;
}): Promise<{
  set: { id: string; name: string } | null;
  name: string;
  config: TeamSetConfig;
  notes: string[];
  issues: NamedCheckIssue[];
  /** How the would-be setup places people who didn't answer: the setting, and the mode a run would use now. */
  non_respondents: { setting: TeamSetNonRespondents | null; resolved: TeamSetNonRespondents };
}> {
  const {
    fields,
    setFields,
    existing,
    base,
    name: setName,
  } = await resolveBase(classroomId, formId, {
    ...(setRef !== undefined ? { setRef } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(newSet ? { fresh: true } : {}),
  });
  // Numbered as a save would number its pins (withPinNumbering).
  const current = existing ? await withPinNumbering(getPrisma(), existing.id, base) : base;
  const { config, notes } = patched(current, patch, fields);
  const { issues, compiled } = await compileFor({
    classroomId,
    formId,
    setName,
    config,
    seed: 0,
    includePassed,
    inputs: await loadInputs({ classroomId, formId, setFields }),
  });
  const pinProblem = await pinPeopleProblem(
    getPrisma(),
    classroomId,
    existing ? base : null,
    config
  );
  const all: CheckIssue[] = pinProblem
    ? [{ level: 'error', code: 'invalid_config', message: pinProblem }, ...issues]
    : issues;
  return {
    set: existing ? { id: existing.id, name: existing.name } : null,
    name: setName,
    config,
    notes,
    issues: await nameIssues(classroomId, all, setFields.mask),
    non_respondents: {
      setting: config.non_respondents ?? null,
      resolved: compiled?.non_respondents ?? resolveNonRespondents(config),
    },
  };
}

/** Refuse `run_in_progress` when one of the set's runs is QUEUED or RUNNING. */
async function assertNoRunInProgress(
  db: Pick<Prisma.TransactionClient, 'teamSetRun'>,
  teamSetId: string
): Promise<void> {
  const active = await db.teamSetRun.findFirst({
    where: { team_set_id: teamSetId, status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  if (active) {
    throw new TeamSetError('run_in_progress', `Run ${active.number} has not finished.`, {
      run_number: active.number,
    });
  }
}

/**
 * Compile, check, and queue a solve.
 *
 * Refused `set_locked` once a create was claimed (isSetLocked), and
 * `run_in_progress` while another run of the set is QUEUED or RUNNING (runs
 * past their wait are expired first, so a dead one never blocks). Any
 * error-level check returns `{ run: null, issues }` and inserts nothing — the
 * caller's `checks_failed`. Otherwise the run is numbered under the set's ROW
 * LOCK (max+1 alone is a race at READ COMMITTED: two starts would both read 3
 * and one would hit the unique index) — where the lock and the in-progress
 * run are checked again, so two starts at once make one run. The config is
 * read and compiled under that lock too, so the run is solved with the setup
 * as it stands when it is numbered, never one a concurrent save replaced. It
 * is inserted QUEUED with the warnings in `diagnostics.issues`, and handed to
 * Trigger. No
 * Trigger, or a trigger call that throws, leaves the row FAILED
 * `trigger_unavailable` — returned, not thrown, so the caller can say so.
 *
 * The run's config snapshot carries the non_respondents the compile USED
 * (the setting, or its default for this count), so a run always says how it
 * placed people who didn't answer.
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
  const set = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  assertUnlocked(set);
  await expireLostRuns({ team_set_id: set.id });
  const prisma = getPrisma();
  await assertNoRunInProgress(prisma, set.id);

  const runSeed = seed ?? Math.floor(Math.random() * MAX_SEED);
  // The form's side (fields, roster, responses) does not depend on the set's
  // config, so it is read before the lock; the config is read and compiled
  // under it, so a save that lands meanwhile is either all in this run or
  // not in it at all.
  const inputs = await loadInputs({ classroomId, formId: set.form_id });
  const { mask } = inputs;

  // The compile inside is synchronous: once it starts, the transaction (and
  // the set's row lock) is held until it returns, even past START_RUN_TX's
  // timeout; only then does Prisma see the time is up (P2028, set_busy).
  const started = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM team_sets WHERE id = ${set.id} FOR UPDATE`;
      const locked = await tx.teamSet.findUniqueOrThrow({
        where: { id: set.id },
        select: { name: true, config: true, created_run_id: true, create_state: true },
      });
      assertUnlocked(locked);
      await assertNoRunInProgress(tx, set.id);
      const { config, issues, compiled } = compileLoaded({
        setName: locked.name,
        config: parseStoredConfig(locked.config),
        seed: runSeed,
        inputs,
      });
      if (!compiled || issues.some(issue => issue.level === 'error')) {
        return { inserted: null, issues };
      }
      // The mode the compile used: a default Group that couldn't seat the
      // people who didn't answer is stored as the Spread it ran with.
      const snapshot: TeamSetConfig = { ...config, non_respondents: compiled.non_respondents };
      const last = await tx.teamSetRun.aggregate({
        where: { team_set_id: set.id },
        _max: { number: true },
      });
      const inserted = await tx.teamSetRun.create({
        data: {
          team_set_id: set.id,
          number: (last._max.number ?? 0) + 1,
          status: 'QUEUED',
          config: toJson(snapshot),
          problem: toJson(compiled.problem),
          context: toJson(compiled.context),
          inputs: toJson(inputs.snapshot),
          seed: runSeed,
          engine: TEAM_SET_ENGINE,
          diagnostics: issues.length > 0 ? toJson({ issues }) : Prisma.DbNull,
          created_by: userId,
        },
      });
      return { inserted, issues };
    },
    // The compile runs inside: allow it more than the default five seconds.
    START_RUN_TX
  );
  const outcome = await started.catch((error: unknown) => {
    // It ran out of time, waiting for the set or compiling: no run was made.
    if (isTransactionTimeout(error)) {
      throw new TeamSetError('set_busy', SET_BUSY_RUN_TEXT, { action: 'run' });
    }
    throw error;
  });
  const issues = outcome.issues;
  if (!outcome.inserted) {
    return { run: null, issues: await nameIssues(classroomId, issues, mask) };
  }
  const inserted = outcome.inserted;

  let final = inserted;
  let triggered = false;
  if (isTriggerConfigured()) {
    try {
      // One solve per run, however often this call is retried by a client or
      // a flaky network: Trigger returns the existing run for a repeated key.
      // The ttl is the QUEUED expiry: the queue drops the solve at the age
      // this file stops waiting for it (`queue_expired`), instead of starting
      // it long after the run says FAILED. One that slips through by a moment
      // finds the run no longer QUEUED (markRunning) and does nothing.
      const handle = await tasks.trigger(
        SOLVE_TASK_ID,
        { runId: inserted.id },
        {
          idempotencyKey: `${SOLVE_TASK_ID}:${inserted.id}`,
          ttl: RUN_QUEUED_TTL_MS / 1000,
        }
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
  return { run: toRunRow(final), issues: await nameIssues(classroomId, issues, mask) };
}

export interface TeamSetRunListItem {
  id: string;
  number: number;
  status: TeamSetRunStatus;
  /** ISO times. */
  created_at: string;
  finished_at: string | null;
  error: string | null;
  /** The engine's status; null until it answered. */
  solver_status: TeamSetSolveStatus | null;
  /** See gapPct; null when not reported. */
  gap_pct: number | null;
  /** From the metrics; null until solved, and for free teams (no picks). */
  first_choice: number | null;
  responded: number | null;
  created_by: PersonRef | null;
  /** The pick fields are null for free teams (metricsView). */
  metrics: TeamSetMetricsView | null;
  /** Only with `withStaleness`, and only for SOLVED runs; null otherwise. */
  stale?: boolean | null;
}

/**
 * The population rule a stored snapshot ran with. New snapshots carry the
 * resolved value; for older ones it is resolved from the snapshot itself.
 */
function snapshotNonRespondents(config: unknown): TeamSetNonRespondents {
  const snapshot = config as Partial<TeamSetConfig> | null;
  if (snapshot?.non_respondents) return snapshot.non_respondents;
  return snapshot?.team_size ? resolveNonRespondents(snapshot as TeamSetConfig) : 'include';
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
      solver: true,
      created_by: true,
      config: true,
    },
  });
  const names = await namesFor(
    classroomId,
    rows.map(row => row.created_by)
  );
  // The form's mask, read once: a run grouped by a question in it lists its
  // metrics as its view does (shownMetrics), with nothing per option.
  const grouped = rows.some(
    row => (row.config as Partial<TeamSetConfig> | null)?.grouping?.mode === 'by_option'
  );
  const mask = grouped ? await identityMaskForForm({ formId: set.form_id }) : new Set<string>();
  const items: TeamSetRunListItem[] = rows.map(row => {
    const solver = (row.solver as unknown as SolverSummary | null) ?? null;
    const free = isFreeSnapshot(row.config);
    const config = row.config as unknown as TeamSetConfig | null;
    const metrics = (row.metrics as unknown as TeamSetMetrics | null) ?? null;
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      created_at: row.created_at.toISOString(),
      finished_at: row.finished_at?.toISOString() ?? null,
      error: row.error,
      solver_status: solver?.status ?? null,
      gap_pct: gapPct(solver),
      ...metricCounts(row.metrics, free),
      created_by: personRefOf(row.created_by, names),
      metrics:
        config?.grouping && groupingMasked({ config }, mask)
          ? shownMetrics({ config, metrics }, true)
          : metricsView(metrics, free),
    };
  });
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
      snapshots.map(row => ({ inputs: row.inputs as unknown as RunInputs, config: row.config })),
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
  /** The form's identity mask now (formIdentity.identityMaskForForm). */
  mask: ReadonlySet<string>;
}

async function loadCurrentState(
  classroomId: string,
  form: { id: string; current_revision_id: string | null },
  mask?: ReadonlySet<string>
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
  return {
    revisionId: form.current_revision_id,
    rosterIds,
    responses,
    mask: mask ?? (await identityMaskForForm({ formId: form.id })),
  };
}

/**
 * Whether a run's setup took answers from a question that is in the form's
 * identity mask now: the question it grouped by, or the question of an active
 * rule that places people by the answer — any job but no one alone (the one
 * job an identity question takes) and note (shown, never solved). A setup
 * can't do that once the question is flagged, so such a run was solved
 * before the flag, and its teams follow those answers.
 */
function usedMaskedQuestion(config: unknown, mask: ReadonlySet<string>): boolean {
  if (mask.size === 0) return false;
  const snapshot = config as Partial<TeamSetConfig> | null;
  const grouping = snapshot?.grouping;
  if (grouping?.mode === 'by_option' && mask.has(grouping.field_id)) return true;
  return (snapshot?.rules ?? []).some(
    rule =>
      rule.strength !== 'off' &&
      rule.job !== 'no_one_alone' &&
      rule.job !== 'note' &&
      mask.has(rule.field_id)
  );
}

/**
 * Why each snapshot is stale against `current` (empty = not stale): the form
 * republished, a question the run used now an identity question
 * (usedMaskedQuestion), answers edited, responses added or removed, and — when
 * people who didn't answer count — the roster changed. One answers read
 * covers every snapshot, and it reads only the responses whose `updated_at`
 * moved.
 */
async function staleReasons(
  snapshots: { inputs: RunInputs; config: unknown }[],
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

  return snapshots.map(({ inputs, config }) => {
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

    let roster: { joined: number; left: number } | null = null;
    if (snapshotNonRespondents(config) !== 'exclude') {
      const before = new Set(inputs.roster_user_ids);
      const now = new Set(current.rosterIds);
      roster = {
        joined: current.rosterIds.filter(id => !before.has(id)).length,
        left: inputs.roster_user_ids.filter(id => !now.has(id)).length,
      };
    }
    return staleReasonTexts({
      republished: current.revisionId !== inputs.revision_id,
      identity: usedMaskedQuestion(config, current.mask),
      edited,
      added,
      removed,
      roster,
    });
  });
}

/**
 * Whether a run's inputs still match the form (staleReasons). Takes only
 * what it reads — the set id, the snapshot and the setup — so a caller
 * holding a light row need not load the problem or context to ask. `mask`:
 * the form's identity mask when the caller has read it already.
 */
export async function staleness({
  classroomId,
  run,
  mask,
}: {
  classroomId: string;
  run: { team_set_id: string; inputs: RunInputs; config: unknown };
  mask?: ReadonlySet<string>;
}): Promise<{ stale: boolean; reasons: string[] }> {
  const set = await findSetScoped(classroomId, run.team_set_id);
  const form = await loadForm(classroomId, set.form_id);
  const current = await loadCurrentState(classroomId, form, mask);
  const [reasons] = await staleReasons([{ inputs: run.inputs, config: run.config }], current);
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
 * Tokens: {set}, {n} (two digits: the team's `n`, else its position in
 * `teams`), {option} (the option's `team_name`, else a 24-char slug of its
 * label).
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
  teams: { option_id: string | null; n?: number }[],
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
    const n = String(team.n ?? index + 1).padStart(2, '0');
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
    const unique = firstFreeName(name, isFree);
    used.add(predictTeamSlug(unique));
    return unique;
  });
}

/** `name`, or `name-2`, `name-3`, … (suffix after truncating to the cap) — the first that is free. */
function firstFreeName(name: string, isFree: (name: string) => boolean): string {
  let unique = name;
  for (let k = 2; !isFree(unique); k++) {
    const suffix = `-${k}`;
    unique = `${name.slice(0, MAX_TEAM_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  return unique;
}

/**
 * Keep a list of names, but move every one whose slug is taken (in `taken`,
 * reserved, or already held by an earlier name in the list) to its first free
 * suffix. Positions in `fixed` (0-based) are never renamed — they are teams
 * that exist — and nothing else may land on their slugs.
 *
 * A retry uses this instead of `teamNamesFor`, so the names the owner approved
 * the first time stay put unless something now holds them.
 */
export function renameTaken(
  names: string[],
  fixed: ReadonlySet<number>,
  taken: Iterable<string>
): string[] {
  const used = new Set([...taken].map(slug => slug.toLowerCase()));
  for (const i of fixed) if (names[i] !== undefined) used.add(predictTeamSlug(names[i]!));
  const isFree = (name: string) => {
    const slug = predictTeamSlug(name);
    return !used.has(slug) && !isReservedSlug(slug);
  };
  return names.map((name, i) => {
    if (fixed.has(i)) return name;
    const unique = firstFreeName(name, isFree);
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
 * The names a run's teams go by, in the order views list the teams
 * (shownOrder): for the run whose create was claimed, the names that claim
 * stored (those are the teams that exist); for any other run, what a create
 * would name them against the classroom's teams today. `withoutOption` (a
 * run whose grouping question is now masked): every team that doesn't exist
 * yet is named without `{option}` and numbered in that order
 * (namesWithoutOption), so no name says which option a team is on; a team
 * that exists keeps its name.
 */
async function plannedNames(
  set: TeamSetDbRow,
  run: TeamSetRunRow,
  optionLabels: Map<string, string>,
  withoutOption = false
): Promise<string[]> {
  const teams = run.result?.teams ?? [];
  const state = readCreateState(set.create_state);
  const claimed =
    set.created_run_id === run.id && state?.names?.length === teams.length ? state : null;
  if (!withoutOption) {
    if (claimed) return claimed.names!;
    return teamNamesFor(
      set.name,
      run.config,
      teams,
      optionLabels,
      await classroomTeamSlugs(set.classroom_id)
    );
  }
  const names = await namesWithoutOptionNow(set, run, claimed);
  return shownOrder(teams, true).map(i => names[i]!);
}

/**
 * The names of a run whose grouping question is masked now, in result order
 * (namesWithoutOption): a team `claimed` (the set's create state of this run,
 * or null) records as made keeps its name; every other team is named
 * without `{option}`, clear of the classroom's teams today — as the run's
 * views name it and as a retry of that create names it.
 */
async function namesWithoutOptionNow(
  set: Pick<TeamSetDbRow, 'classroom_id' | 'name'>,
  run: Pick<TeamSetRunRow, 'config' | 'result'>,
  claimed: CreateState | null
): Promise<string[]> {
  return namesWithoutOption(
    set.name,
    run.config,
    run.result?.teams ?? [],
    claimed?.names ?? [],
    claimed ? indexesOf(createdPositions(claimed)) : new Set(),
    await classroomTeamSlugs(set.classroom_id)
  );
}

/**
 * A create's state as reads take it, still in result order, and `order`: the
 * run's teams in the order its views list them (shownOrder) when the run's
 * grouping question is masked now, else null (views list them as stored).
 *
 * With `order`, `sizes` is filled from the run when the state has none. A
 * FAILED create of such a run still holds the names planned at its claim,
 * and those can carry `{option}`: until a retry is claimed, every team it did
 * not make goes by the name that retry gives it (namesWithoutOptionNow) — in
 * `names`, in its failures, and with no earlier rename of it listed. The
 * teams it made keep their names. Any other state is taken as stored.
 *
 * Reads: the run's config, then (grouped by a question) the form's mask, and
 * the run's result only when the mask covers the grouping question.
 */
async function createStateForReads(
  set: Pick<TeamSetDbRow, 'classroom_id' | 'form_id' | 'name'>,
  state: CreateState
): Promise<{ state: CreateState; order: number[] | null }> {
  const planned = state.names;
  if (!planned?.length) return { state, order: null };
  const prisma = getPrisma();
  const configRow = await prisma.teamSetRun.findUnique({
    where: { id: state.run_id },
    select: { config: true },
  });
  const config = (configRow?.config as unknown as TeamSetConfig | null) ?? null;
  if (config?.grouping?.mode !== 'by_option') return { state, order: null };
  if (!groupingMasked({ config }, await identityMaskForForm({ formId: set.form_id }))) {
    return { state, order: null };
  }
  const resultRow = await prisma.teamSetRun.findUnique({
    where: { id: state.run_id },
    select: { result: true },
  });
  const run = { config, result: (resultRow?.result as unknown as RunResult | null) ?? null };
  const teams = run.result?.teams ?? [];
  if (planned.length !== teams.length) return { state, order: null };

  const order = shownOrder(teams, true);
  const sizes =
    state.sizes?.length === planned.length
      ? state.sizes
      : teams.map(team => team.member_user_ids.length);
  if (state.status !== 'FAILED') return { state: { ...state, sizes }, order };

  const names = await namesWithoutOptionNow(set, run, state);
  const made = indexesOf(createdPositions(state));
  const shownName = new Map<string, string>();
  planned.forEach((name, i) => {
    if (!made.has(i)) shownName.set(name, names[i]!);
  });
  const renamed = (state.renamed ?? []).filter(entry => made.has(entry.n - 1));
  const { renamed: _stored, ...rest } = state;
  return {
    state: {
      ...rest,
      names,
      sizes,
      failed: state.failed.map(failure =>
        shownName.has(failure.team) ? { ...failure, team: shownName.get(failure.team)! } : failure
      ),
      ...(renamed.length > 0 ? { renamed } : {}),
    },
    order,
  };
}

/**
 * `state` (result order) with its teams in `order` (result indices in the
 * order the run's views list them): `names` and `sizes` in that order, each
 * made team's and each rename's `n` its position there, teams and renames
 * sorted by it, and failures by the position of the team they name (a
 * failure of the whole create, or of no listed team, last). For reads only:
 * the stored state stays in result order, which the apply, a retry's
 * adoption and createdPositions go by.
 */
function inShownOrder(state: CreateState, order: readonly number[]): CreateState {
  const names = state.names ?? [];
  const shownN = new Map(order.map((i, k) => [i + 1, k + 1]));
  const positionOf = new Map(names.map((name, i) => [name, shownN.get(i + 1)]));
  const LAST = Number.MAX_SAFE_INTEGER;
  const byN = (a: { n?: number }, b: { n?: number }) => (a.n ?? LAST) - (b.n ?? LAST);
  return {
    ...state,
    names: order.map(i => names[i]!),
    ...(state.sizes?.length === names.length ? { sizes: order.map(i => state.sizes![i]!) } : {}),
    teams: state.teams
      .map(team => {
        const n = shownN.get(team.n ?? names.indexOf(team.name) + 1);
        return n === undefined ? team : { ...team, n };
      })
      .sort(byN),
    ...(state.renamed
      ? {
          renamed: state.renamed
            .map(entry => ({ ...entry, n: shownN.get(entry.n) ?? entry.n }))
            .sort(byN),
        }
      : {}),
    failed: state.failed
      .map((failure, i) => ({ failure, i, at: positionOf.get(failure.team) ?? LAST }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map(({ failure }) => failure),
  };
}

/**
 * A create's state as reads show it (createStateForReads): with the run's
 * grouping question masked now, its teams numbered and listed as the run's
 * views list them (inShownOrder), so a team's `n` here is its `n` there.
 */
async function shownCreateState(
  set: Pick<TeamSetDbRow, 'classroom_id' | 'form_id' | 'name'>,
  state: CreateState
): Promise<CreateState> {
  const read = await createStateForReads(set, state);
  return read.order ? inShownOrder(read.state, read.order) : read.state;
}

/** A set row with its create state as reads show it (shownCreateState). */
async function toShownSetRow(row: TeamSetDbRow): Promise<TeamSetRow> {
  const set = toSetRow(row);
  return set.create_state
    ? { ...set, create_state: await shownCreateState(row, set.create_state) }
    : set;
}

/**
 * Indices into a run's result.teams in the order views list them: as stored
 * (slot order), or — `hide`, the run's grouping question being in the
 * identity mask now — by each team's smallest member id: the list and the
 * numbers follow the members, not the options.
 */
function shownOrder(teams: readonly { member_user_ids: readonly string[] }[], hide: boolean) {
  const order = teams.map((_, i) => i);
  if (!hide) return order;
  const key = teams.map(team => [...team.member_user_ids].sort()[0] ?? '');
  return order.sort((a, b) => (key[a]! < key[b]! ? -1 : key[a]! > key[b]! ? 1 : a - b));
}

/**
 * The names of a run whose grouping question is masked now, in result order:
 * a team in `kept` (0-based; it exists) keeps `stored[i]`; every other team
 * is named without `{option}`, numbered in the order views list the teams
 * (shownOrder), clear of `taken` and of the kept names.
 */
function namesWithoutOption(
  setName: string,
  config: TeamSetConfig,
  teams: readonly { member_user_ids: readonly string[] }[],
  stored: readonly string[],
  kept: ReadonlySet<number>,
  taken: Iterable<string>
): string[] {
  const keep = (i: number) => kept.has(i) && stored[i] !== undefined;
  const names = teams.map((_, i) => (keep(i) ? stored[i]! : ''));
  const toName = shownOrder(teams, true)
    .map((i, k) => ({ i, n: k + 1 }))
    .filter(({ i }) => !keep(i));
  const fresh = teamNamesFor(
    setName,
    config,
    toName.map(({ n }) => ({ option_id: null, n })),
    new Map(),
    [...taken, ...names.filter(Boolean).map(name => predictTeamSlug(name))]
  );
  toName.forEach(({ i }, k) => {
    names[i] = fresh[k]!;
  });
  return names;
}

// ─── Describe ───────────────────────────────────────────────────────────────

/** A revision's top-level fields (empty when it is gone). */
async function revisionFields(revisionId: string | null): Promise<FormField[]> {
  if (!revisionId) return [];
  const revision = await getPrisma().formRevision.findUnique({
    where: { id: revisionId },
    select: { fields: true },
  });
  return fieldsOf(revision?.fields);
}

/**
 * The fields with every question in the form's identity mask flagged as an
 * identity question, so the pure helpers (placementFacts, teamSignals) skip
 * it too — the mask also covers flags set after the run was solved.
 */
function flagMasked(fields: FormField[], mask: ReadonlySet<string>): FormField[] {
  return fields.map(field =>
    mask.has(field.id) && !isIdentityQuestion(field) ? { ...field, identity_question: true } : field
  );
}

/** The rule's question id: `context.rules[].field_id`, else the rule id's first part. */
const ruleFieldId = (rule: { id: string; field_id?: string }): string =>
  rule.field_id ?? rule.id.split(':')[0] ?? '';

/**
 * Whether the question a run grouped by is in the form's identity mask now —
 * flagged after the run was solved (a setup can't group by one). Views of
 * such a run show no option per team or per person: with the members listed,
 * a team's option would say each member's answer.
 */
function groupingMasked(run: Pick<TeamSetRunRow, 'config'>, mask: ReadonlySet<string>): boolean {
  const grouping = run.config.grouping;
  return grouping.mode === 'by_option' && mask.has(grouping.field_id);
}

/**
 * A person's placement as a view of the run shows it: null for free teams
 * (nobody ranks an option there, so there is no placement to state), and
 * null when it would be read from an answer to a question in the identity
 * mask now. Every placement when the grouping question is (their ranked
 * options are hidden); 'missed' when a fallback rule's question is (without
 * their categories, placed by category and not placed by it read the same).
 */
function shownPlacement(
  placement: PersonPlacement['placement'] | null | undefined,
  run: Pick<TeamSetRunRow, 'config' | 'context'>,
  mask: ReadonlySet<string>
): PersonPlacement['placement'] | null {
  if (placement === null || placement === undefined || run.config.grouping.mode === 'free') {
    return null;
  }
  if (groupingMasked(run, mask)) return null;
  if (placement !== 'missed' || mask.size === 0) return placement;
  const categoriesHidden = run.context.rules.some(
    rule => rule.job === 'fallback' && mask.has(ruleFieldId(rule))
  );
  return categoriesHidden ? null : placement;
}

/**
 * A run as the explain helpers read it, with the form's identity mask
 * applied. Context entries of a masked question (balance values, note
 * questions) are dropped, and its rules marked as identity rules. A person's
 * answers to a masked question the run placed people by are dropped too:
 * their ranked options when it is the grouping question (no rank, placement
 * or higher pick is derived from it), their categories for a fallback rule,
 * the options they pitched for an owner rule, their answer for a priority
 * rule. With the grouping question masked, the teams are in the order views
 * list them (shownOrder), so every team number the helpers give follows it.
 */
function explainRunOf(run: TeamSetRunRow, mask: ReadonlySet<string> = new Set()): ExplainRun {
  const { context } = run;
  const masked = (fieldId: string) => mask.has(fieldId);
  const maskedRules = (job: TeamSetJob) =>
    context.rules.filter(rule => rule.job === job && masked(ruleFieldId(rule)));
  const ranked = groupingMasked(run, mask);
  const categories = maskedRules('fallback').length > 0;
  const pitched = maskedRules('owner').length > 0;
  const priority = new Set(maskedRules('priority').map(rule => rule.id));
  const people =
    ranked || categories || pitched || priority.size > 0
      ? context.people.map(person => ({
          ...person,
          ...(ranked ? { ranked: [] } : {}),
          ...(categories ? { categories: [] } : {}),
          ...(pitched ? { pitched: [] } : {}),
          ...(person.priority && priority.size > 0
            ? { priority: person.priority.filter(entry => !priority.has(entry.rule_id)) }
            : {}),
        }))
      : context.people;
  return {
    number: run.number,
    config: run.config,
    problem: run.problem,
    context:
      mask.size === 0
        ? context
        : {
            ...context,
            people,
            rules: context.rules.map(rule =>
              masked(ruleFieldId(rule)) ? { ...rule, identity: true } : rule
            ),
            ...(context.note_field_ids
              ? { note_field_ids: context.note_field_ids.filter(id => !masked(id)) }
              : {}),
            ...(context.balance
              ? { balance: context.balance.filter(entry => !masked(entry.field_id)) }
              : {}),
          },
    result: ranked && run.result ? shownResult(run.result, true) : run.result,
    metrics: run.metrics,
  };
}

/** A stored result with its teams in the order views list them (shownOrder). */
function shownResult<T extends { member_user_ids: string[] }>(
  result: { teams: T[] },
  hide: boolean
): { teams: T[] } {
  return { ...result, teams: shownOrder(result.teams, hide).map(i => result.teams[i]!) };
}

/** Label maps over several field lists (the first holding a field wins). */
function labelsFor(
  fieldLists: FormField[][],
  config: Pick<TeamSetConfig, 'grouping'>,
  names?: ReadonlyMap<string, string | null>
): ExplainLabels {
  const seen = new Set<string>();
  const merged: FormField[] = [];
  for (const list of fieldLists) {
    for (const field of list) {
      if (seen.has(field.id)) continue;
      seen.add(field.id);
      merged.push(field);
    }
  }
  return explainLabels(merged, config, names);
}

/** Two label sets as one (the first wins on a clash). */
function mergeLabels(a: ExplainLabels, b: ExplainLabels): ExplainLabels {
  const union = <V>(x?: ReadonlyMap<string, V>, y?: ReadonlyMap<string, V>) =>
    new Map<string, V>([...(y ?? []), ...(x ?? [])]);
  return {
    fields: union(a.fields, b.fields),
    options: union(a.options, b.options),
    choices: union(a.choices, b.choices),
    ...(a.names || b.names ? { names: union(a.names, b.names) } : {}),
  };
}

/**
 * Labels for setup diffs (diffConfigs): every question's options count as
 * options, the grouping question's first, so an option-scoped change (a pin
 * on an option, an option's setting) reads by its label even when the two
 * setups group by different questions.
 */
function diffLabels(labels: ExplainLabels): ExplainLabels {
  const options = new Map(labels.options);
  for (const [id, label] of labels.choices ?? []) if (!options.has(id)) options.set(id, label);
  return { ...labels, options };
}

/** Runs read per page while walking back for closedProvenance. */
const SETUP_PAGE = 20;

/**
 * A set's runs' setups as closedProvenance reads them, oldest first — only
 * the trailing ones it needs. `target` is the setup whose Closed options are
 * traced (the set's current config; for `upTo`, that run's own snapshot).
 * Runs are read newest first (up to `upTo`), a page at a time, until every
 * option Closed in the target is not Closed in at least one run read: its
 * unbroken streak of Closed runs then starts inside what was read, so the
 * answer is the one the whole history gives. With nothing Closed, one page.
 */
async function runSetups(
  teamSetId: string,
  { upTo, current }: { upTo?: number; current?: TeamSetConfig | null } = {}
) {
  const read: { number: number; config: TeamSetConfig; created_by: string }[] = [];
  for (;;) {
    const before = read.at(-1)?.number;
    const number: Prisma.IntFilter = {
      ...(upTo !== undefined ? { lte: upTo } : {}),
      ...(before !== undefined ? { lt: before } : {}),
    };
    const rows = await getPrisma().teamSetRun.findMany({
      where: { team_set_id: teamSetId, ...(Object.keys(number).length > 0 ? { number } : {}) },
      orderBy: { number: 'desc' },
      take: SETUP_PAGE,
      select: { number: true, config: true, created_by: true },
    });
    for (const row of rows) {
      read.push({
        number: row.number,
        config: row.config as unknown as TeamSetConfig,
        created_by: row.created_by,
      });
    }
    if (rows.length < SETUP_PAGE) break;
    const target =
      upTo !== undefined
        ? (read.find(entry => entry.number === upTo)?.config ?? null)
        : (current ?? null);
    const closed = Object.entries(target?.options ?? {})
      .filter(([, settings]) => settings.open === 'closed')
      .map(([optionId]) => optionId);
    const streakMayGoOn = closed.some(optionId =>
      read.every(entry => entry.config.options?.[optionId]?.open === 'closed')
    );
    if (!streakMayGoOn) break;
  }
  return read.reverse();
}

/** The srcs an unsolved run's core names, each once, in the engine's order. */
const coreSrcs = (run: TeamSetRunRow): string[] => [
  ...new Set(
    (run.diagnostics?.core ?? [])
      .map(entry => entry?.src)
      .filter((src): src is string => typeof src === 'string')
  ),
];

/**
 * The run's Can't-solve list, labelled now: names only when `labels` carries
 * them, and no person on a rule of a question in the identity mask.
 */
async function runCoreItems(
  run: TeamSetRunRow,
  labels: ExplainLabels,
  fields: FormField[],
  mask: ReadonlySet<string>
): Promise<CoreItem[]> {
  const srcs = coreSrcs(run);
  if (srcs.length === 0) return [];
  const closed = closedProvenance(
    await runSetups(run.team_set_id, { upTo: run.number }),
    null,
    run.number
  );
  return coreWithoutMaskedPeople(coreItems(srcs, { run, labels, closed, fields }), mask);
}

/** The facts sentence of an INFEASIBLE run, from what the run stored (null for any other status). */
function runSummary(run: TeamSetRunRow): string | null {
  if (run.status !== 'INFEASIBLE') return null;
  const coreStatus = run.diagnostics?.core_status ?? run.solver?.core_status;
  return infeasibleSummary({
    core: coreSrcs(run).length,
    ...(coreStatus ? { core_status: coreStatus } : {}),
    stages: run.solver?.stages ?? null,
    group: run.problem.group?.members.length ?? 0,
    free: run.config.grouping.mode === 'free',
  });
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

/** The run's active no_one_alone rules on identity questions (the mask included). */
function identityRules(run: TeamSetRunRow, mask: ReadonlySet<string>) {
  return run.context.rules.filter(
    rule =>
      rule.job === 'no_one_alone' &&
      rule.off === undefined &&
      (rule.identity === true || mask.has(ruleFieldId(rule)))
  );
}

/**
 * The teams (by number and name) on which a no_one_alone rule missed.
 * `teams` and `teamNames` are in the order the view lists them.
 */
function missedTeams(
  run: TeamSetRunRow,
  teams: readonly { slot: number }[],
  ruleId: string,
  teamNames: readonly string[]
): { n: number; name: string }[] {
  const slots = new Set(ruleMissedSlots(run.problem, assignmentOf(run), ruleId));
  return teams.flatMap((team, i) =>
    slots.has(team.slot) ? [{ n: i + 1, name: teamNames[i] ?? `Team ${i + 1}` }] : []
  );
}

/** The run numbered just below this one (any status), with its setup. */
async function previousRun(run: Pick<TeamSetRunRow, 'team_set_id' | 'number'>) {
  const row = await getPrisma().teamSetRun.findFirst({
    where: { team_set_id: run.team_set_id, number: { lt: run.number } },
    orderBy: { number: 'desc' },
    select: { number: true, config: true },
  });
  return row ? { number: row.number, config: row.config as unknown as TeamSetConfig } : null;
}

/**
 * A run's metrics as its views show them: the pick fields null for free
 * teams (metricsView), and no per-option rows for the people who didn't
 * answer when the run's grouping question is masked now (`hideOption`).
 */
function shownMetrics(
  run: Pick<TeamSetRunRow, 'config' | 'metrics'>,
  hideOption: boolean
): TeamSetMetricsView | null {
  const view = metricsView(run.metrics, run.config.grouping.mode === 'free');
  if (!view || !hideOption || !view.non_respondents) return view;
  return { ...view, non_respondents: { ...view.non_respondents, options: [] } };
}

const EMPTY_SIGNALS: TeamSignals = {
  wanted_first: null,
  seats: { used: 0, max: 0 },
  pitcher_on_team: null,
  requests: { kept: 0, total: 0 },
  pinned: 0,
  did_not_answer: 0,
  fourth_or_lower: 0,
  balance: [],
};

/**
 * A run as its page shows it.
 *
 * Every run: status, the engine's summary (+ `gap_pct`), metrics, staleness,
 * check issues, the current setup's changes since this run, the counts of the
 * Running steps, how many people didn't answer (roster − responses in the
 * run's snapshot) and how the run placed them.
 *
 * INFEASIBLE: the core as CoreItems and the facts sentence, both computed on
 * READ from the stored srcs (runs stored before the sentence was facts-only
 * carry an older one), plus this run's setup against the run before it.
 *
 * SOLVED: the teams with names, their option, signals and (with
 * `includePeople`) members with placement, rank, pins, requests and notes;
 * how each option ran (grouped runs only); and the identity rules' aggregate —
 * on how many teams each held. Which teams missed comes only with
 * `revealIdentity` (team numbers and names; never whose answer). Free teams
 * (no grouping question) have no picks: the metrics' pick fields and every
 * member's placement are null (metricsView, shownPlacement).
 *
 * Names appear only with `includePeople` (the run's starter is always named).
 * No identity answer appears anywhere: notes skip the form's identity mask,
 * and a run whose grouping question is in the mask now shows no option per
 * team (and no `{option}` in names it plans), and no member's rank or
 * placement (explainRunOf, shownPlacement); with a fallback rule's question in
 * the mask, a member on an option they didn't rank shows no placement. Such a
 * run also shows nothing per option: no `option_status`, no per-option
 * counts in the metrics, no pitcher or per-option seat count on a team, and
 * its teams are listed and numbered by their members (shownOrder), not by
 * option.
 *
 * `changes_since_run` compares the run's setup with the current one as a run
 * would use it now: an unset non_respondents is its count-aware mode
 * (effectiveNonRespondents).
 */
export async function describeRun({
  classroomId,
  run,
  includePeople,
  revealIdentity = false,
}: {
  classroomId: string;
  run: TeamSetRunRow;
  includePeople: boolean;
  revealIdentity?: boolean;
}): Promise<RunView> {
  const set = await findSetScoped(classroomId, run.team_set_id);
  const form = await loadForm(classroomId, set.form_id);
  const mask = await identityMaskForForm({ formId: set.form_id });
  const { stale, reasons } = await staleness({ classroomId, run, mask });
  const hideOption = groupingMasked(run, mask);
  const runFields = flagMasked(await revisionFields(run.inputs.revision_id), mask);
  const currentFields =
    form.current_revision_id === run.inputs.revision_id
      ? runFields
      : flagMasked(await revisionFields(form.current_revision_id), mask);
  const issues = run.diagnostics?.issues ?? [];
  const explained = explainRunOf(run, mask);

  let current: TeamSetConfig | null = null;
  try {
    current = parseStoredConfig(set.config);
  } catch {
    current = null;
  }
  const previous = run.status === 'INFEASIBLE' ? await previousRun(run) : null;
  // The pins of every setup this view diffs: their people and who added them.
  const pinIds = [run.config, current, previous?.config]
    .flatMap(config => config?.pins ?? [])
    .flatMap(pin => [...pinPeople(pin), pin.added_by]);
  const names = await namesFor(classroomId, [
    run.created_by,
    ...(includePeople ? [...run.problem.people, ...pinIds] : []),
  ]);
  const shown = includePeople ? names : undefined;
  const labels = labelsFor([runFields, currentFields], run.config, shown);
  const warnings = issues.filter(issue => issue.level === 'warning').length;

  const view: RunView = {
    id: run.id,
    number: run.number,
    status: run.status,
    error: run.error,
    created_at: run.created_at.toISOString(),
    finished_at: run.finished_at?.toISOString() ?? null,
    created_by: personRefOf(run.created_by, names),
    solver: run.solver ? { ...run.solver, gap_pct: gapPct(run.solver) } : null,
    metrics: shownMetrics(run, hideOption),
    stale,
    stale_reasons: reasons,
    // Names (e.g. who has not responded) only for a view that shows people;
    // never on an issue about a question in the identity mask.
    issues: includePeople
      ? await nameIssues(classroomId, issues, mask)
      : withoutMaskedPeople(issues, mask),
    core: run.status === 'INFEASIBLE' ? await runCoreItems(run, labels, runFields, mask) : [],
    summary: runSummary(run),
    changes_since_run: current
      ? diffConfigs(
          run.config,
          {
            ...current,
            non_respondents: await effectiveNonRespondents(
              set,
              current,
              form.current_revision_id
                ? { revisionId: form.current_revision_id, fields: currentFields, mask }
                : undefined
            ),
          },
          diffLabels(labelsFor([currentFields, runFields], run.config, shown))
        )
      : [],
    changes_from_previous: previous
      ? {
          since_run: previous.number,
          items: diffConfigs(previous.config, run.config, diffLabels(labels)),
        }
      : null,
    progress: {
      responses: run.inputs.responses.length,
      people: run.problem.people.length,
      pins: run.config.pins.length,
      warnings,
    },
    identity_rules: [],
    non_respondents: {
      mode: snapshotNonRespondents(run.config),
      people: Math.max(0, run.inputs.roster_user_ids.length - run.inputs.responses.length),
    },
    option_status: [],
    teams: [],
  };
  if (run.status !== 'SOLVED' || !run.result) return view;

  // In the order the view lists them: slot order, or by members when masked.
  const shownTeams = explained.result?.teams ?? [];
  const teamNames = await plannedNames(set, run, new Map(labels.options), hideOption);
  const heldBy = new Map((run.metrics?.rules ?? []).map(rule => [rule.rule_id, rule]));
  view.identity_rules = identityRules(run, mask).flatMap(rule => {
    const held = heldBy.get(rule.id);
    if (!held) return [];
    return [
      {
        rule_id: rule.id,
        label: labels.fields.get(ruleFieldId(rule)) ?? rule.label,
        teams_held: held.teams_held,
        teams_total: held.teams_total,
        ...(revealIdentity
          ? { missed_teams: missedTeams(run, shownTeams, rule.id, teamNames) }
          : {}),
      },
    ];
  });
  if (run.config.grouping.mode === 'by_option' && !hideOption) {
    view.option_status = [...optionStatuses(explained)].map(([optionId, status]) => ({
      option_id: optionId,
      label: labels.options.get(optionId) ?? null,
      ...status,
    }));
  }

  // Masked: nothing per option — the set's own size for seats (the team's
  // when it holds more), no first-pick count or pitcher.
  const signals = teamSignals(explained, labels).map(signal =>
    hideOption
      ? {
          ...signal,
          wanted_first: null,
          pitcher_on_team: null,
          seats: {
            used: signal.seats.used,
            max: Math.max(signal.seats.used, run.problem.size.max),
          },
        }
      : signal
  );
  let placements = new Map<string, PersonPlacement>();
  let logins = new Map<string, string | null>();
  let notesByUser = new Map<string, { field_label: string; text: string }[]>();
  // The masked context: no rank, placement or category from a masked question.
  const contextOf = new Map(explained.context.people.map(person => [person.user_id, person]));
  const pinned = new Set(run.config.pins.flatMap(pinPeople));

  if (includePeople) {
    const { people } = computeMetrics(run.problem, explained.context, assignmentOf(run));
    placements = new Map(people.map(p => [p.user_id, p]));
    const memberIds = run.result.teams.flatMap(t => t.member_user_ids);
    const userRows = await getPrisma().user.findMany({
      where: {
        id: { in: memberIds },
        classroom_memberships: { some: { classroom_id: classroomId } },
      },
      select: { id: true, login: true },
    });
    logins = new Map(userRows.map(u => [u.id, u.login]));
    notesByUser = await loadNotes(set.form_id, run, memberIds, mask);
  }

  view.teams = shownTeams.map((team, i) => {
    const members: RunViewMember[] = includePeople
      ? team.member_user_ids
          .map(userId => {
            const placement = placements.get(userId);
            const requests = placement?.requests ?? [];
            const notes = notesByUser.get(userId);
            const person = contextOf.get(userId);
            const position = team.option_id && person ? person.ranked.indexOf(team.option_id) : -1;
            return {
              user_id: userId,
              name: names.get(userId) ?? null,
              login: logins.get(userId) ?? null,
              placement: shownPlacement(placement?.placement, run, mask),
              rank: position === -1 ? null : position + 1,
              pinned: pinned.has(userId),
              responded: person?.responded ?? false,
              requests_kept: requests.filter(r => r.kept).length,
              requests_total: requests.length,
              ...(notes && notes.length > 0 ? { notes } : {}),
            };
          })
          .sort((a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''))
      : [];
    return {
      n: i + 1,
      name: teamNames[i]!,
      option:
        team.option_id && !hideOption
          ? { id: team.option_id, label: labels.options.get(team.option_id) ?? null }
          : null,
      size: team.member_user_ids.length,
      members,
      signals: signals[i] ?? EMPTY_SIGNALS,
    };
  });
  return view;
}

/**
 * Notes shown next to each person: answers to fields that carry a `note` rule,
 * read from the responses NOW (they are for reading, not solving). Text-shaped
 * answers only, trimmed and capped. Skipped: an `email`-type field (this view
 * reaches MCP clients, and the contract for it is "no emails") and every
 * question in the form's identity mask — flagged now, whatever the run's
 * context says.
 */
async function loadNotes(
  formId: string,
  run: TeamSetRunRow,
  userIds: string[],
  mask: ReadonlySet<string>
): Promise<Map<string, { field_label: string; text: string }[]>> {
  const out = new Map<string, { field_label: string; text: string }[]>();
  const noteFieldIds = (
    run.context.note_field_ids ??
    run.config.rules.filter(r => r.job === 'note' && r.strength !== 'off').map(r => r.field_id)
  ).filter(id => !mask.has(id));
  if (noteFieldIds.length === 0 || userIds.length === 0) return out;

  const fieldsById = new Map(
    flattenFields(await revisionFields(run.inputs.revision_id)).map(f => [f.id, f])
  );
  const noteFields = noteFieldIds
    .map(id => fieldsById.get(id))
    .filter((f): f is FormField => Boolean(f) && f!.type !== 'email' && !isIdentityQuestion(f));
  if (noteFields.length === 0) return out;

  const responses = await getPrisma().formResponse.findMany({
    where: { form_id: formId, submission_state: 'SUBMITTED', user_id: { in: userIds } },
    select: { user_id: true, answers: true },
  });
  for (const response of responses) {
    if (!response.user_id) continue;
    const answers = withoutAnswers((response.answers ?? {}) as Record<string, unknown>, mask);
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

/**
 * The teams (numbers and names) on which the run's identity rules missed —
 * the page's "Show which", on explicit request only (the caller audits it).
 * Never whose answer. `ruleId` narrows to one rule; otherwise every identity
 * rule of the run, each team once. [] for a run without teams.
 */
export async function identityMissedTeams({
  classroomId,
  teamSetId,
  runRef,
  ruleId,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
  ruleId?: string;
}): Promise<{ n: number; name: string }[]> {
  const set = await findSetScoped(classroomId, teamSetId);
  const run = await getRun({ classroomId, teamSetId: set.id, runRef });
  if (run.status !== 'SOLVED' || !run.result) return [];
  const mask = await identityMaskForForm({ formId: set.form_id });
  const rules = identityRules(run, mask).filter(rule => ruleId === undefined || rule.id === ruleId);
  if (rules.length === 0) return [];
  const hideOption = groupingMasked(run, mask);
  const teamNames = await plannedNames(set, run, await optionLabelsFor(run), hideOption);
  const teams = shownResult(run.result, hideOption).teams;
  const byN = new Map<number, { n: number; name: string }>();
  for (const rule of rules) {
    for (const team of missedTeams(run, teams, rule.id, teamNames)) byN.set(team.n, team);
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/**
 * Why each person of a solved run is where they are (placementFacts): their
 * team and mates, rank, what they pitched and how it ran, the pins naming
 * them, where the previous solved run put them when that differs, the picks
 * above theirs with each option's status, their together requests, their own
 * note answers and what their priority answers did. Everyone in the run, or
 * only `userIds`. [] for a run without teams.
 *
 * Answers are read with the form's identity mask stripped, and masked
 * questions are passed as identity questions, so no identity answer can
 * reach a fact. A run whose grouping question is in the mask now names no
 * option for a person (their team's, a previous run's, a request's), no
 * rank, placement or higher pick (explainRunOf, shownPlacement), and nothing
 * they pitched; its teams are numbered by their members (shownOrder). The previous run's option is null when that
 * run's grouping question is in the mask now; when either is, "moved since"
 * compares teammates, as compareRuns does. A previous option is labelled
 * from every question of both runs' forms, so one of a question the set no
 * longer groups by still has its label. A fallback rule's question in the
 * mask leaves `placement` null for someone on an option they didn't rank;
 * free teams have no placement at all.
 */
export async function explainPlacements({
  classroomId,
  teamSetId,
  runRef,
  userIds,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
  userIds?: string[];
}): Promise<PlacementFacts[]> {
  const set = await findSetScoped(classroomId, teamSetId);
  const run = await getRun({ classroomId, teamSetId: set.id, runRef });
  if (run.status !== 'SOLVED' || !run.result) return [];
  const mask = await identityMaskForForm({ formId: set.form_id });
  const fields = flagMasked(await revisionFields(run.inputs.revision_id), mask);

  const prisma = getPrisma();
  const earlier = await prisma.teamSetRun.findFirst({
    where: { team_set_id: set.id, status: 'SOLVED', number: { lt: run.number } },
    orderBy: { number: 'desc' },
    select: { number: true, result: true, config: true, inputs: true },
  });
  const earlierConfig = (earlier?.config as unknown as TeamSetConfig | null) ?? null;
  const earlierMasked = earlierConfig !== null && groupingMasked({ config: earlierConfig }, mask);
  const earlierRevision = (earlier?.inputs as unknown as RunInputs | null)?.revision_id ?? null;
  const earlierFields =
    earlier && earlierRevision !== run.inputs.revision_id
      ? flagMasked(await revisionFields(earlierRevision), mask)
      : [];
  const wanted = userIds ? new Set(userIds) : null;
  const people = run.problem.people.filter(id => !wanted || wanted.has(id));

  const names = await namesFor(classroomId, [
    ...run.problem.people,
    ...run.config.pins.flatMap(pin => [...pinPeople(pin), pin.added_by]),
  ]);
  const labels = labelsFor([fields, earlierFields], run.config, names);
  const hideOption = groupingMasked(run, mask);
  const teamNames = await plannedNames(set, run, new Map(labels.options), hideOption);
  const responses =
    people.length > 0
      ? await prisma.formResponse.findMany({
          where: { form_id: set.form_id, submission_state: 'SUBMITTED', user_id: { in: people } },
          select: { user_id: true, answers: true },
        })
      : [];
  const answers = new Map(
    responses
      .filter((row): row is typeof row & { user_id: string } => Boolean(row.user_id))
      .map(row => [
        row.user_id,
        withoutAnswers((row.answers ?? {}) as Record<string, unknown>, mask),
      ])
  );

  const earlierResult = (earlier?.result as unknown as RunResult | null) ?? null;
  const facts = placementFacts({
    run: explainRunOf(run, mask),
    teamNames,
    previous: earlier
      ? {
          number: earlier.number,
          result: earlierResult && shownResult(earlierResult, earlierMasked),
        }
      : null,
    ...(hideOption || earlierMasked ? { previousByTeammates: true } : {}),
    fields,
    labels,
    answers,
    ...(userIds ? { userIds } : {}),
  }).map(fact => ({
    ...fact,
    placement: shownPlacement(fact.placement, run, mask),
    previous:
      fact.previous && (hideOption || earlierMasked)
        ? { ...fact.previous, option: null }
        : fact.previous,
  }));
  if (!hideOption) return facts;
  return facts.map(fact => ({
    ...fact,
    team: { ...fact.team, option: null },
    pitched: [],
    requests: fact.requests.map(request => ({ ...request, on: { ...request.on, option: null } })),
  }));
}

/**
 * Run `runRef` compared with run `otherRunRef` (compareAssignments): the setup
 * changes from the other run's to this one's, the metric rows with deltas
 * (no pick rows when either makes free teams), who moved with only pin and
 * request facts, and how many stayed. `grouped`: both runs group by a
 * question that isn't in the identity mask now (movers are by option;
 * otherwise by teammates, with no option or rank on either seat, and teams
 * numbered by their members when a run's grouping question is masked).
 * Names only with `includePeople`. Both runs must be SOLVED
 * (`run_not_solved` otherwise, details `{ run_number, status }` of the first
 * that isn't): a run without teams has no placements to compare.
 */
export async function compareRuns({
  classroomId,
  teamSetId,
  runRef,
  otherRunRef,
  includePeople,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
  otherRunRef: string | number;
  includePeople: boolean;
}): Promise<RunComparisonView> {
  const set = await findSetScoped(classroomId, teamSetId);
  const run = await getRun({ classroomId, teamSetId: set.id, runRef });
  const other = await getRun({ classroomId, teamSetId: set.id, runRef: otherRunRef });
  for (const entry of [run, other]) {
    if (entry.status !== 'SOLVED' || !entry.result) {
      throw new TeamSetError(
        'run_not_solved',
        `Run ${entry.number} is ${entry.status}, not SOLVED; only solved runs can be compared.`,
        { run_number: entry.number, status: entry.status }
      );
    }
  }
  const mask = await identityMaskForForm({ formId: set.form_id });
  const fieldsRun = flagMasked(await revisionFields(run.inputs.revision_id), mask);
  const fieldsOther =
    other.inputs.revision_id === run.inputs.revision_id
      ? fieldsRun
      : flagMasked(await revisionFields(other.inputs.revision_id), mask);

  const names = includePeople
    ? await namesFor(
        classroomId,
        [run, other].flatMap(r => [
          ...r.problem.people,
          ...r.config.pins.flatMap(pin => [...pinPeople(pin), pin.added_by]),
        ])
      )
    : undefined;
  const labels = mergeLabels(
    labelsFor([fieldsRun, fieldsOther], run.config, names),
    labelsFor([fieldsOther, fieldsRun], other.config, names)
  );
  // A run grouped by a question now in the mask: movers are by teammates, and
  // no mover's seat names an option.
  const hideOption = groupingMasked(run, mask) || groupingMasked(other, mask);
  const compared = compareAssignments(explainRunOf(run, mask), explainRunOf(other, mask), labels, {
    byTeammates: hideOption,
  });
  const comparison = hideOption
    ? {
        ...compared,
        moved: compared.moved.map(mover => ({
          ...mover,
          from: { ...mover.from, option: null, rank: null },
          to: { ...mover.to, option: null, rank: null },
        })),
      }
    : compared;
  // The setup changes read option labels across every question (diffLabels),
  // so a change after a grouping switch still names its options.
  const changes = diffConfigs(other.config, run.config, diffLabels(labels));

  const contextRules = [...run.context.rules, ...other.context.rules];
  const rule_labels: Record<string, string> = {};
  for (const row of comparison.metrics) {
    if (!row.rule_id || row.rule_id in rule_labels) continue;
    const rule = contextRules.find(entry => entry.id === row.rule_id);
    const fieldId = rule ? ruleFieldId(rule) : (row.rule_id.split(':')[0] ?? '');
    rule_labels[row.rule_id] = labels.fields.get(fieldId) ?? rule?.label ?? row.rule_id;
  }
  return {
    ...comparison,
    changes,
    grouped:
      !hideOption &&
      run.config.grouping.mode === 'by_option' &&
      other.config.grouping.mode === 'by_option',
    rule_labels,
  };
}

/**
 * What changed in the set's setup since a run (default: its latest run, of
 * any status): diffConfigs(run's snapshot, current config), over resolved
 * values — the current non_respondents as a run would use it now
 * (`nonRespondents` when the caller has it, else effectiveNonRespondents,
 * which compiles only for an unset setting on teams of two). `run_number`
 * null (and no changes) when the set has no run yet. Pin texts name their
 * people and who added them (names are always resolved here, classroom
 * members only): a staff surface's read.
 */
export async function changesSinceRun({
  classroomId,
  teamSetId,
  runRef,
  nonRespondents,
}: {
  classroomId: string;
  teamSetId: string;
  runRef?: string | number;
  /** The current setup's mode as a run would use it now (nonRespondentsFor's `resolved`). */
  nonRespondents?: TeamSetNonRespondents;
}): Promise<{ run_number: number | null; changes: SetupChange[] }> {
  const set = await findSetScoped(classroomId, teamSetId);
  const current = parseStoredConfig(set.config);
  let run: { number: number; config: TeamSetConfig; revisionId: string | null } | null = null;
  if (runRef !== undefined) {
    const row = await getRun({ classroomId, teamSetId: set.id, runRef });
    run = { number: row.number, config: row.config, revisionId: row.inputs.revision_id };
  } else {
    const row = await getPrisma().teamSetRun.findFirst({
      where: { team_set_id: set.id },
      orderBy: { number: 'desc' },
      select: { number: true, config: true, inputs: true },
    });
    if (row) {
      run = {
        number: row.number,
        config: row.config as unknown as TeamSetConfig,
        revisionId: (row.inputs as unknown as RunInputs | null)?.revision_id ?? null,
      };
    }
  }
  if (!run) return { run_number: null, changes: [] };

  const form = await loadForm(classroomId, set.form_id);
  const currentFields = await revisionFields(form.current_revision_id);
  const runFields =
    run.revisionId === form.current_revision_id ? [] : await revisionFields(run.revisionId);
  const names = await namesFor(
    classroomId,
    [...run.config.pins, ...current.pins].flatMap(pin => [...pinPeople(pin), pin.added_by])
  );
  const labels = diffLabels(labelsFor([currentFields, runFields], run.config, names));
  const effective = nonRespondents ?? (await effectiveNonRespondents(set, current));
  return {
    run_number: run.number,
    changes: diffConfigs(run.config, { ...current, non_respondents: effective }, labels),
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

/** Field types whose answers are option ids (their class counts are per option). */
const CHOICE_TYPES: readonly FormFieldType[] = ['dropdown', 'multiselect'];

/** A field the Questions card lists: a top-level input that isn't a container. */
const isQuestion = (field: FormField): boolean =>
  (FIELD_TYPE_REGISTRY as Record<string, { kind: string }>)[field.type]?.kind === 'input' &&
  field.type !== 'repeat_group';

/**
 * Team counts team_size alone allows for `people` at the fewest teams off
 * their size (minimalFlex over free slots), within the team count: the
 * Setup's range when the config doesn't compile, null when those counts have
 * a gap or none fits. A config that does compile gets the checks' own
 * (teamCountRange), which also counts per-option sizes, closed and
 * forced-open options and the people who didn't answer as a group.
 */
function sizeOnlyRange(config: TeamSetConfig, people: number) {
  const { min, max } = config.team_size;
  const slots = Array.from({ length: Math.ceil(people / min) }, () => ({ option: 0, min, max }));
  const kMin = Math.max(1, config.team_count.min ?? 1);
  const kMax = Math.min(slots.length, config.team_count.max ?? slots.length);
  if (kMin > kMax) return null;
  const counts = minimalFlex(people, slots, { kMin, kMax })?.counts ?? [];
  if (counts.length === 0 || counts.at(-1)! - counts[0]! + 1 !== counts.length) return null;
  return { min: counts[0]!, max: counts.at(-1)! };
}

/** How many answers each option (or switch value) got: class counts, never who. */
function answerCountsOf(field: FormField, responses: LoadedResponse[]) {
  if (field.type === 'switch') {
    const yes = responses.filter(r => r.answers[field.id] === true).length;
    const no = responses.filter(r => r.answers[field.id] === false).length;
    return [
      { option_id: 'true', label: 'Yes', count: yes },
      { option_id: 'false', label: 'No', count: no },
    ];
  }
  return fieldOptions(field).map(option => ({
    option_id: option.id,
    label: option.label,
    count: responses.filter(r => answerIds(r.answers[field.id]).includes(option.id)).length,
  }));
}

/**
 * Everything the Setup tab shows for one set: its status and lock, readiness
 * (roster, answered, form close), every question of the form with the jobs it
 * can take, its rules, Must sentences (ruleMustLabel) and class counts, the
 * team shape, people who didn't answer, pins, the grouping question's options
 * (wanted, runs, size, note, pitchers, pins, since when Closed), the roster
 * for the pickers, the checks with passed ones included, and the changes
 * since the latest run.
 *
 * Identity questions (and any question in the form's identity mask) give
 * class counts only: no pitcher, note, or average is read from them.
 * Pitchers come from every submitted response to an owner rule's question;
 * someone off the roster is listed without id or name.
 */
export async function getSetup({
  classroomId,
  formId,
  setRef,
}: {
  classroomId: string;
  formId: string;
  setRef?: string;
}): Promise<SetupView> {
  const form = await loadForm(classroomId, formId);
  const row = await resolveSetRow(classroomId, formId, setRef);
  if (!row) throw new TeamSetError('not_found', 'Team set not found on this form.');
  const set = withStatus(toSetRow(await expireLostCreate(row)));
  const { config } = set;
  const { revisionId, fields, mask } = await loadSetFields(form);

  const rosterIds = await loadRosterUserIds(classroomId);
  const onRoster = new Set(rosterIds);
  const submitted = await loadSubmittedResponses(form.id);
  const responses = submitted.filter(r => onRoster.has(r.user_id));
  const runs = await runSetups(set.id, { current: config });
  const latest = runs.at(-1) ?? null;
  const provenance = closedProvenance(runs, config);

  // ── Options of the grouping question, and who pitched them ──
  const groupingId = config.grouping.mode === 'by_option' ? config.grouping.field_id : null;
  const groupingField = fields.find(field => field.id === groupingId);
  const groupingOptions = groupingField ? fieldOptions(groupingField) : [];
  const optionIds = new Set(groupingOptions.map(option => option.id));
  const ownerFieldIds = [
    ...new Set(config.rules.filter(rule => rule.job === 'owner').map(rule => rule.field_id)),
  ].filter(id => !mask.has(id));
  const pitchedBy = new Map<string, Set<string>>();
  for (const response of submitted) {
    for (const fieldId of ownerFieldIds) {
      for (const id of answerIds(response.answers[fieldId])) {
        if (!optionIds.has(id)) continue;
        const who = pitchedBy.get(id) ?? new Set<string>();
        who.add(response.user_id);
        pitchedBy.set(id, who);
      }
    }
  }

  const names = await namesFor(classroomId, [
    ...rosterIds,
    ...config.pins.flatMap(pin => [...pinPeople(pin), pin.added_by]),
    ...(latest?.config.pins ?? []).flatMap(pin => [...pinPeople(pin), pin.added_by]),
    ...[...provenance.values()].map(entry => entry.by),
  ]);
  const labels = labelsFor([fields], config, names);

  // ── Questions ──
  const questions: SetupQuestionView[] = fields.filter(isQuestion).map(field => {
    const hidden = mask.has(field.id);
    const identity = isIdentityQuestion(field);
    const rules = config.rules.filter(rule => rule.field_id === field.id);
    const jobs = jobsAllowedFor(field);
    const must_labels: Partial<Record<TeamSetJob, string>> = {};
    for (const job of jobs) {
      const rule = rules.find(entry => entry.job === job);
      const label = ruleMustLabel({ job, params: rule?.params ?? {} }, field);
      if (label) must_labels[job] = label;
    }

    const answered = responses.filter(r => isAnswered(r.answers[field.id])).length;
    const counts: SetupQuestionView['counts'] = {
      answered,
      skipped: responses.length - answered,
    };
    if (field.type === 'roster_select' && !hidden) {
      const asks = new Map<string, Set<string>>();
      for (const response of responses) {
        const ids = answerIds(response.answers[field.id]).filter(
          id => onRoster.has(id) && id !== response.user_id
        );
        asks.set(response.user_id, new Set(ids));
      }
      let requests = 0;
      let mutual = 0;
      for (const [asker, asked] of asks) {
        requests += asked.size;
        for (const other of asked) if (asker < other && asks.get(other)?.has(asker)) mutual += 1;
      }
      counts.requests = requests;
      counts.mutual = mutual;
    }
    if (!hidden && groupingField && ownerFieldIds.includes(field.id)) {
      counts.pitchers = responses.filter(r =>
        answerIds(r.answers[field.id]).some(id => optionIds.has(id))
      ).length;
    }
    if ((field.type === 'opinion_scale' || field.type === 'number') && !identity && !hidden) {
      const values = responses
        .map(r => r.answers[field.id])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      counts.class_average = values.length
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
        : null;
    }

    const typeFacts: SetupQuestionView['type_facts'] = { required: field.required === true };
    if (CHOICE_TYPES.includes(field.type) || field.type === 'ranked_choice') {
      typeFacts.options = fieldOptions(field).length;
    }
    if (field.type === 'ranked_choice') typeFacts.ranks = fieldRanks(field);
    if (field.type === 'roster_select') {
      typeFacts.source = field.optionSource === 'teaching_team' ? 'teaching_team' : 'roster';
    }
    const bounds = numericBounds(field);
    if (bounds) {
      typeFacts.min = bounds.min;
      typeFacts.max = bounds.max;
    }

    const countable =
      CHOICE_TYPES.includes(field.type) || field.type === 'switch'
        ? identity || hidden || TEAM_SET_JOB_FIELD_TYPES.priority.includes(field.type)
        : false;
    return {
      field_id: field.id,
      label: typeof field.label === 'string' ? field.label : '',
      type: field.type,
      type_facts: typeFacts,
      identity,
      help_text: typeof field.help === 'string' && field.help.trim() ? field.help : null,
      jobs_allowed: jobs,
      rules,
      must_labels,
      counts,
      ...(countable ? { answer_counts: answerCountsOf(field, responses) } : {}),
    };
  });

  // ── Options ──
  const options: SetupOptionView[] = groupingOptions.map(option => {
    const settings = config.options[option.id];
    let first = 0;
    let top3 = 0;
    for (const response of responses) {
      const ranked = answerIds(response.answers[groupingField!.id]);
      if (ranked[0] === option.id) first += 1;
      if (ranked.slice(0, 3).includes(option.id)) top3 += 1;
    }
    const pitchers = [...(pitchedBy.get(option.id) ?? [])];
    const closed = settings?.open === 'closed' ? provenance.get(option.id) : undefined;
    return {
      option_id: option.id,
      label: option.label,
      description: option.description ?? null,
      wanted: { first, top3 },
      runs: settings?.open ?? 'auto',
      size: settings?.size
        ? { min: settings.size.min ?? null, max: settings.size.max ?? null }
        : null,
      note: settings?.note ?? null,
      pitchers: [
        ...pitchers
          .filter(id => onRoster.has(id))
          .map(id => personRefOf(id, names))
          .sort(byPersonName)
          .map(person => ({ ...person, on_roster: true })),
        ...pitchers
          .filter(id => !onRoster.has(id))
          .map(() => ({ user_id: null, name: null, on_roster: false })),
      ],
      pinned_here: config.pins.flatMap(pin =>
        pin.kind === 'on_option' && pin.option_id === option.id
          ? [{ pin_id: pin.id, user_id: pin.user_id, name: names.get(pin.user_id) ?? null }]
          : []
      ),
      ...(closed ? { closed: closedProvenanceView(closed, names) } : {}),
    };
  });

  // ── Checks (passed ones included) ──
  const inputs = inputsOf({ revisionId, fields, mask }, rosterIds, responses);
  const { issues, compiled } = await compileFor({
    classroomId,
    formId: form.id,
    setName: set.name,
    config,
    seed: 0,
    includePassed: true,
    inputs,
  });
  // The mode a run would use now: a default Group that can't seat the people
  // who didn't answer is Spread (count-aware; a config that doesn't compile
  // gets the plain default).
  const resolved = compiled?.non_respondents ?? resolveNonRespondents(config);
  const people = resolved === 'exclude' ? responses.length : rosterIds.length;

  const now = Date.now();
  return {
    set: {
      id: set.id,
      name: set.name,
      status: set.status,
      locked: set.locked,
      config,
      updated_at: set.updated_at.toISOString(),
    },
    readiness: {
      roster: rosterIds.length,
      answered: responses.length,
      not_answered: rosterIds.length - responses.length,
      closes_at: form.closes_at?.toISOString() ?? null,
      closed:
        form.status === 'CLOSED' || (form.closes_at !== null && form.closes_at.getTime() <= now),
    },
    grouping: {
      mode: config.grouping.mode,
      field_id: config.grouping.mode === 'by_option' ? config.grouping.field_id : null,
    },
    questions,
    shape: {
      people,
      team_count_range: compiled
        ? teamCountRange(compiled.problem, compiled.context)
        : sizeOnlyRange(config, people),
    },
    non_respondents: {
      mode: config.non_respondents ?? null,
      resolved,
      count: rosterIds.length - responses.length,
    },
    pins: config.pins.map(pin => toPinView(pin, labels)),
    options,
    roster: rosterIds.map(id => personRefOf(id, names)).sort(byPersonName),
    checks: await nameIssues(classroomId, issues, mask),
    // The setup as a run would use it now: non_respondents count-aware.
    changes: latest
      ? {
          since_run: latest.number,
          items: diffConfigs(
            latest.config,
            { ...config, non_respondents: resolved },
            diffLabels(labels)
          ),
        }
      : { since_run: null, items: [] },
  };
}

/**
 * How many students are on the roster and how many of them answered: two
 * counts, no answer read (the MCP setup view's readiness). SUBMITTED
 * responses with a user id are one per user (a partial unique index), so the
 * count of those by roster members is the number who answered.
 */
export async function readinessCounts({
  classroomId,
  formId,
}: {
  classroomId: string;
  formId: string;
}): Promise<{ roster: number; responded: number }> {
  await loadForm(classroomId, formId);
  const rosterIds = await loadRosterUserIds(classroomId);
  const responded =
    rosterIds.length === 0
      ? 0
      : await getPrisma().formResponse.count({
          where: { form_id: formId, submission_state: 'SUBMITTED', user_id: { in: rosterIds } },
        });
  return { roster: rosterIds.length, responded };
}

/**
 * What Must means for each rule of `config` (ruleMustLabel, the one template
 * the page's Setup uses too), keyed by rule id `<field_id>:<job>`, against the
 * form's current questions with its identity mask applied. A rule that can't
 * be Must, or whose question is no longer on the form, has no entry.
 */
export async function mustLabels({
  classroomId,
  formId,
  config,
}: {
  classroomId: string;
  formId: string;
  config: Pick<TeamSetConfig, 'rules'>;
}): Promise<Record<string, string>> {
  const form = await loadForm(classroomId, formId);
  const { fields } = await loadCurrentRevision(form);
  const mask = await identityMaskForForm({ formId: form.id });
  const byId = new Map(flagMasked(fields, mask).map(field => [field.id, field]));
  const labels: Record<string, string> = {};
  for (const rule of config.rules) {
    const field = byId.get(rule.field_id);
    const label = field ? ruleMustLabel(rule, field) : null;
    if (label) labels[teamSetRuleId(rule)] = label;
  }
  return labels;
}

// ─── Create: preview, claim, apply ──────────────────────────────────────────

interface CreatePlan {
  set: TeamSetDbRow;
  run: TeamSetRunRow;
  tag: { id: string; name: string } | null;
  /** Every team of the run, named — before the GitHub pre-flight (which may rename on a retry). */
  teams: { n: number; name: string; option_id: string | null; member_user_ids: string[] }[];
  optionLabels: Map<string, string>;
  /** The FAILED create this claim retries, or null for a first create. */
  previous: CreateState | null;
  /** `previous` was a create of THIS run: its teams are kept and skipped. */
  sameRun: boolean;
  /** Positions (1-based `n`) of this run's teams that already exist: recorded, or adopted. */
  alreadyCreated: Set<number>;
  /** Teams found on the tag under a planned name that no attempt recorded (see CreateState.teams). */
  adopted: { team_id: string; name: string; n: number; adopted: true }[];
  /** Slugs a new team name must avoid locally: the classroom's teams, minus this run's own. */
  localTaken: string[];
  /** Same-run retry only: why the run is stale. Not a refusal — the retry keeps the run's grouping. */
  staleReasons: string[];
  /** The run's grouping question is in the form's identity mask now: no option is shown per team. */
  hideOption: boolean;
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

/** 1-based positions as the 0-based index set `renameTaken` and the pre-flight take. */
const indexesOf = (positions: Set<number>): Set<number> => new Set([...positions].map(n => n - 1));

/**
 * The classroom's git organization. A create makes one GitHub team per team,
 * so an organization on another provider is refused `provider_unsupported`
 * before anything else — a GitLab classroom must hear "GitHub only", not
 * "GitHub cannot be reached".
 */
async function loadCreateOrg(classroomId: string) {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: {
      git_organization: {
        select: { provider: true, login: true, github_installation_id: true },
      },
    },
  });
  const org = classroom?.git_organization ?? null;
  if (org && org.provider !== 'GITHUB') {
    throw new TeamSetError(
      'provider_unsupported',
      'Creating teams from a team set needs a GitHub organization; this classroom’s is not on GitHub.',
      { provider: org.provider }
    );
  }
  return org;
}

/**
 * Everything previewCreate and claimCreate both refuse on, in the order a
 * caller can act on them. Uses the RUN's config snapshot (template,
 * github_teams): the preview of a run must not change because the set's config
 * was edited after it was solved.
 *
 * A set whose create was already claimed may be claimed again only when that
 * create FAILED: for the same run (the teams it made are skipped), or — when
 * it made no team at all — for any run (another run while teams exist is
 * `already_created`). RUNNING is `create_in_progress`; DONE and PARTIAL
 * (every team exists) are `set_locked`. A create always makes GitHub teams:
 * `githubTeams: false`, or a run whose setup says github_teams false, is
 * refused `github_teams_off_unsupported`.
 *
 * A SAME-RUN retry differs from a first create in three ways:
 *   - Its names start from the ones the last claim stored (what the owner
 *     approved, and what any team it made is called), not recomputed ones —
 *     except when the run's grouping question is an identity question now:
 *     every team not made yet is then named without `{option}`
 *     (namesWithoutOption), and only the teams that exist keep theirs.
 *   - A team on the set's tag that the state never recorded — its attempt
 *     made it, then died or failed its final write — is ADOPTED when it holds
 *     the planned name of a position not yet made: that position counts as
 *     created and the retry re-adds its members. Only a tagged team matching
 *     no planned name is someone else's (`tag_conflict`).
 *   - Ordinary staleness does not block it: the grouping is already partly
 *     real, and edited answers change nothing about the teams still to make.
 *     Only a member of such a team who has left the class (or whose account is
 *     gone) blocks it, as `run_stale`.
 */
async function planCreate(
  classroomId: string,
  teamSetId: string,
  runRef: string | number,
  githubTeams?: boolean
): Promise<CreatePlan> {
  const set = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  await loadCreateOrg(classroomId);
  const run = await getRun({ classroomId, teamSetId, runRef });

  let previous: CreateState | null = null;
  if (set.created_run_id) {
    const state = readCreateState(set.create_state);
    if (!state || state.status === 'RUNNING') {
      throw new TeamSetError('create_in_progress', 'Teams for this set are being created now.');
    }
    if (state.status === 'DONE' || state.status === 'PARTIAL') {
      // Every team exists: the set is locked, whichever run is named.
      throw new TeamSetError(
        'set_locked',
        `Teams were created from run ${state.run_number} of this set; its setup is fixed.`,
        { run_number: state.run_number, status: state.status }
      );
    }
    const retryable = set.created_run_id === run.id || state.teams.length === 0;
    if (!retryable) {
      throw new TeamSetError(
        'already_created',
        `Teams were partly created from run ${state.run_number}; only that run can be retried.`,
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
  if (githubTeams === false || run.config.github_teams === false) {
    throw new TeamSetError(
      'github_teams_off_unsupported',
      'Creating teams makes a GitHub team for each; classroom-only teams are not made.'
    );
  }

  const prisma = getPrisma();
  const sameRun = previous !== null && set.created_run_id === run.id;
  const mask = await identityMaskForForm({ formId: set.form_id });
  // A grouping question flagged since the run: a first create is refused as
  // stale below; names computed here leave {option} empty all the same.
  const hideOption = groupingMasked(run, mask);
  const runTeams = run.result.teams;
  const optionLabels = await optionLabelsFor(run);

  // Teams a previous attempt of THIS run recorded are ours: they sit on the
  // tag and hold their names, and neither is a conflict for the retry.
  const recorded = sameRun ? previous!.teams : [];
  const ours = new Set(recorded.map(team => team.team_id));
  const alreadyCreated = new Set<number>();
  let names: string[] = [];
  if (sameRun) {
    names =
      previous!.names?.length === runTeams.length
        ? [...previous!.names]
        : teamNamesFor(
            set.name,
            run.config,
            runTeams,
            optionLabels,
            await classroomTeamSlugs(classroomId, ours)
          );
    // The teams that exist keep the names they were made with.
    for (const team of recorded) {
      const n = team.n ?? (previous!.names ? previous!.names.indexOf(team.name) + 1 : 0);
      if (n < 1 || n > names.length) continue;
      names[n - 1] = team.name;
      alreadyCreated.add(n);
    }
  }

  const tag = await prisma.tag.findUnique({
    where: { classroom_id_name: { classroom_id: classroomId, name: set.name } },
    select: {
      id: true,
      name: true,
      teams: { select: { team: { select: { id: true, name: true, slug: true } } } },
    },
  });
  const adopted: CreatePlan['adopted'] = [];
  const foreign: { name: string; slug: string }[] = [];
  for (const { team } of tag?.teams ?? []) {
    if (ours.has(team.id)) continue;
    const slug = team.slug.toLowerCase();
    const index = sameRun
      ? names.findIndex(
          (name, i) =>
            !alreadyCreated.has(i + 1) &&
            (predictTeamSlug(name) === slug || name.toLowerCase() === team.name.toLowerCase())
        )
      : -1;
    if (index < 0) {
      foreign.push(team);
      continue;
    }
    names[index] = team.name;
    alreadyCreated.add(index + 1);
    ours.add(team.id);
    adopted.push({ team_id: team.id, name: team.name, n: index + 1, adopted: true });
  }

  const { stale, reasons } = await staleness({ classroomId, run, mask });
  let staleReasons: string[] = [];
  if (sameRun) {
    const pending = runTeams
      .filter((_, i) => !alreadyCreated.has(i + 1))
      .flatMap(team => team.member_user_ids);
    if (pending.length > 0) {
      const roster = new Set(await loadRosterUserIds(classroomId));
      const users = await prisma.user.findMany({
        where: { id: { in: pending } },
        select: { id: true },
      });
      const exists = new Set(users.map(user => user.id));
      const gone = pending.filter(id => !roster.has(id) || !exists.has(id)).length;
      if (gone > 0) {
        const reason = retryBlockedText(gone);
        throw new TeamSetError('run_stale', `Run ${run.number} cannot be retried: ${reason}`, {
          reasons: [reason],
          retry_blocked: true,
        });
      }
    }
    staleReasons = reasons;
  } else if (stale) {
    throw new TeamSetError('run_stale', `Run ${run.number} is out of date: ${reasons.join(' ')}`, {
      reasons,
    });
  }

  if (foreign.length > 0) {
    // A FAILED create of ANOTHER run that left teams on the tag without
    // recording them: those teams are that run's, and only it can be retried.
    const previousSlugs = new Set((previous?.names ?? []).map(name => predictTeamSlug(name)));
    if (previous && foreign.some(team => previousSlugs.has(team.slug.toLowerCase()))) {
      throw new TeamSetError(
        'already_created',
        `Teams were partly created from run ${previous.run_number}; only that run can be retried.`,
        { run_number: previous.run_number, status: previous.status }
      );
    }
    throw new TeamSetError('tag_conflict', `The tag "${set.name}" already has teams.`, {
      tag: set.name,
      teams: foreign.length,
    });
  }

  const localTaken = await classroomTeamSlugs(classroomId, ours);
  // Masked: every team not made yet (not recorded, not adopted above, which
  // matched the stored names) is named without {option}.
  const created = indexesOf(alreadyCreated);
  if (sameRun) {
    names = renameTaken(
      hideOption
        ? namesWithoutOption(set.name, run.config, runTeams, names, created, localTaken)
        : names,
      created,
      localTaken
    );
  } else {
    names = hideOption
      ? namesWithoutOption(set.name, run.config, runTeams, [], new Set(), localTaken)
      : teamNamesFor(set.name, run.config, runTeams, optionLabels, localTaken);
  }

  return {
    set,
    run,
    tag: tag ? { id: tag.id, name: tag.name } : null,
    teams: runTeams.map((team, i) => ({
      n: i + 1,
      name: names[i]!,
      option_id: team.option_id,
      member_user_ids: team.member_user_ids,
    })),
    optionLabels,
    previous,
    sameRun,
    alreadyCreated,
    adopted,
    localTaken,
    staleReasons,
    hideOption,
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

/** The pre-flight's budget ran out. */
class PreflightTimeout extends Error {}

function githubUnavailable(timeout = false): TeamSetError {
  return timeout
    ? new TeamSetError(
        'github_unavailable',
        'GitHub did not answer in time while the team names were checked.',
        { reason: 'timeout' }
      )
    : new TeamSetError(
        'github_unavailable',
        'The classroom’s GitHub organization cannot be reached.'
      );
}

/**
 * Ask GitHub whether each slug is a team, a few at a time. The FIRST answer
 * that is neither "exists" nor 404 ends it at once: that error is thrown
 * without waiting for the other lanes, no lane takes another slug, and the
 * requests still in flight are aborted.
 */
async function probeSlugs(
  provider: ReturnType<typeof getGitHubProvider>,
  org: string,
  slugs: string[],
  controller: AbortController
): Promise<Set<string>> {
  const taken = new Set<string>();
  let stopped = false;
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const lanes = eachLimited(slugs, NAME_PROBE_CONCURRENCY, async slug => {
    if (stopped || controller.signal.aborted) return;
    try {
      if (await provider.probeTeam(org, slug, { signal: controller.signal })) taken.add(slug);
    } catch (error) {
      if (stopped) return;
      stopped = true;
      fail(error);
      controller.abort();
    }
  });
  await Promise.race([lanes, failed]);
  return taken;
}

/**
 * Before an owner is asked to approve (and, on a retry, again at the claim so
 * it stores the same names), make sure the create can reach GitHub and that no
 * name still to be made is already a team in the organization — another
 * classroom in the same org, a team made by hand, or a GitHub team a failed
 * attempt left behind are all invisible to the local check.
 *
 * The organization read comes FIRST and must succeed: a dead installation can
 * answer a team lookup with 404, which would otherwise read as "name free".
 * Every request goes through the provider's probe client (a rate limit is
 * thrown, never slept off; nothing is retried) under one AbortController, and
 * the whole pre-flight — token mint included — is raced against
 * PREFLIGHT_BUDGET_MS. Any answer but "exists" or 404 refuses
 * `github_unavailable` at once; running out of time refuses it too, asking
 * the caller to try again. Nothing here waits on GitHub past the budget.
 *
 * A taken name refuses `name_collision`, with the list, on a FIRST attempt:
 * the owner has approved nothing yet and picks another template. On a RETRY
 * it is suffixed instead (usually it is a GitHub team the failed attempt made
 * and could not record) and the new names are probed in turn, for up to
 * NAME_PROBE_ROUNDS rounds. Positions in `fixed` (0-based) exist already and
 * are neither probed nor renamed.
 */
async function githubPreflight({
  classroomId,
  names,
  fixed,
  localTaken,
  retry,
}: {
  classroomId: string;
  names: string[];
  fixed: ReadonlySet<number>;
  localTaken: string[];
  retry: boolean;
}): Promise<{ names: string[]; warnings: string[] }> {
  const org = await loadCreateOrg(classroomId);
  if (!org?.login || !org.github_installation_id) throw githubUnavailable();
  const orgLogin = org.login;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PreflightTimeout());
      controller.abort();
    }, preflightBudgetMs);
  });
  // Every rejection of `budget` is observed by a race below; this only keeps
  // one that lands between races from being reported as unhandled.
  budget.catch(() => {});
  const withinBudget = <T>(work: Promise<T>): Promise<T> => Promise.race([work, budget]);

  try {
    const provider = getGitHubProvider(org.github_installation_id, orgLogin);
    await withinBudget(provider.probeOrganization(orgLogin, { signal: controller.signal }));

    const open = names.map((_, i) => i).filter(i => !fixed.has(i));
    if (open.length > NAME_PROBE_MAX_TEAMS) {
      return {
        names,
        warnings: [namesNotCheckedWarning(NAME_PROBE_MAX_TEAMS)],
      };
    }

    const free = new Set<string>();
    const onGithub = new Set<string>();
    let current = names;
    for (let round = 1; ; round++) {
      const pending = [...new Set(open.map(i => predictTeamSlug(current[i]!)))].filter(
        slug => !free.has(slug) && !onGithub.has(slug)
      );
      const taken = await withinBudget(probeSlugs(provider, orgLogin, pending, controller));
      for (const slug of pending) (taken.has(slug) ? onGithub : free).add(slug);

      const colliding = open.filter(i => onGithub.has(predictTeamSlug(current[i]!)));
      if (colliding.length === 0) return { names: current, warnings: [] };
      if (!retry || round >= NAME_PROBE_ROUNDS) {
        const listed = colliding.map(i => current[i]!);
        throw new TeamSetError('name_collision', nameCollisionText(listed), { names: listed });
      }
      // From the ORIGINAL names each round, against everything found taken
      // so far: `x-02` → `x-02-2` → `x-02-3`, never `x-02-2-2`.
      current = renameTaken(names, fixed, [...localTaken, ...onGithub]);
    }
  } catch (error) {
    if (error instanceof TeamSetError) throw error;
    if (error instanceof PreflightTimeout) throw githubUnavailable(true);
    console.error(
      `[teamSet] GitHub pre-flight failed for classroom ${classroomId}`,
      statusOf(error) ?? (error instanceof Error ? error.name : 'unknown')
    );
    throw githubUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a create of a run would make, for the owner to approve: team names
 * (checked against GitHub), options, members, the tag, and facts worth
 * knowing (accounts without a GitHub login; on a same-run retry, what changed
 * since the run). Creates nothing. Refused like claimCreate (planCreate).
 * `githubTeams` is the Create dialog's checkbox: false is refused
 * `github_teams_off_unsupported`.
 */
export async function previewCreate({
  classroomId,
  teamSetId,
  runRef,
  githubTeams,
}: {
  classroomId: string;
  teamSetId: string;
  runRef: string | number;
  githubTeams?: boolean;
}): Promise<CreatePreview> {
  const plan = await planCreate(classroomId, teamSetId, runRef, githubTeams);
  const { names, warnings } = await githubPreflight({
    classroomId,
    names: plan.teams.map(team => team.name),
    fixed: indexesOf(plan.alreadyCreated),
    localTaken: plan.localTaken,
    retry: plan.previous !== null,
  });
  const teams = plan.teams.map((team, i) => ({ ...team, name: names[i]! }));
  const toMake = teams.filter(team => !plan.alreadyCreated.has(team.n));

  const memberIds = teams.flatMap(t => t.member_user_ids);
  // Classroom members only, like every name a view carries (namesFor).
  const users = await getPrisma().user.findMany({
    where: {
      id: { in: memberIds },
      classroom_memberships: { some: { classroom_id: classroomId } },
    },
    select: { id: true, name: true, login: true },
  });
  const byId = new Map(users.map(u => [u.id, u]));
  const noLogin = toMake.flatMap(t => t.member_user_ids).filter(id => !byId.get(id)?.login).length;
  if (noLogin > 0) warnings.unshift(noLoginWarning(noLogin));
  if (plan.staleReasons.length > 0) {
    warnings.push(changedSinceRunWarning(plan.run.number, plan.staleReasons));
  }

  return {
    run_id: plan.run.id,
    run_number: plan.run.number,
    tag: { name: plan.set.name, exists: plan.tag !== null },
    github_teams: true,
    name_template: plan.run.config.team_name_template,
    students: memberIds.length,
    // Masked grouping: listed by members, not by option (shownOrder).
    teams: shownOrder(teams, plan.hideOption).map(i => {
      const team = teams[i]!;
      return {
        name: team.name,
        option:
          team.option_id && !plan.hideOption
            ? { id: team.option_id, label: plan.optionLabels.get(team.option_id) ?? null }
            : null,
        size: team.member_user_ids.length,
        members: team.member_user_ids.map(id => ({
          user_id: id,
          name: byId.get(id)?.name ?? null,
          login: byId.get(id)?.login ?? null,
        })),
      };
    }),
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
 * The teams a same-run retry renamed: a position whose name differs from the
 * one the failed attempt planned (a GitHub or classroom team now holds it).
 * An earlier retry's renames are kept, from their first planned name.
 */
function renamedOnRetry(
  previous: CreateState,
  names: string[]
): { n: number; from: string; to: string }[] {
  const earlier = new Map((previous.renamed ?? []).map(entry => [entry.n, entry.from]));
  const out: { n: number; from: string; to: string }[] = [];
  names.forEach((to, i) => {
    const n = i + 1;
    const from = earlier.get(n) ?? previous.names?.[i];
    if (from !== undefined && from !== to) out.push({ n, from, to });
  });
  return out;
}

/**
 * A set's create as the Creating and Created screens show it: per team done,
 * live (being made now), queued or failed, with members added of its size;
 * the teams a retry renamed; every failure with the people named (classroom
 * members only). Sizes come from the state (stored at claim); a state claimed
 * before that reads the run's result once. Team names are the state's as
 * reads show them (shownCreateState).
 *
 * `github_team` is derived from what exists, never assumed: true for a team
 * the state records as made (createTeam makes the GitHub team before the
 * local one, so a recorded team has one); false for the team being made now
 * ('live' — not recorded until the next progress write) and for a queued one.
 * A team that failed `name_collision` is true when a team of the classroom
 * holds its name (every classroom team is mirrored from a GitHub team — the
 * create that collided found it there), false otherwise.
 *
 * The rows are worked out in result order, the order the apply makes the
 * teams in (so 'live' is the team being made now), then listed and numbered
 * as reads show the state (shownCreateState): a row's `n` is its team's `n`
 * in the run's views, and so are `renamed[].n`.
 */
async function createProgress(
  set: Pick<TeamSetDbRow, 'classroom_id' | 'form_id' | 'name' | 'tag_id'>,
  stored: CreateState
): Promise<CreateProgressView> {
  const { state, order } = await createStateForReads(set, stored);
  const shown = order ? inShownOrder(state, order) : state;
  const planned = state.names ?? [];
  let sizes = state.sizes;
  if (!sizes || sizes.length !== planned.length) {
    const run = await getPrisma().teamSetRun.findUnique({
      where: { id: state.run_id },
      select: { result: true },
    });
    const runTeams = (run?.result as unknown as RunResult | null)?.teams ?? [];
    sizes = planned.map((_, i) => runTeams[i]?.member_user_ids.length ?? 0);
  }

  const made = new Map<number, CreateState['teams'][number]>();
  for (const team of state.teams) {
    const n = team.n ?? planned.indexOf(team.name) + 1;
    if (n > 0) made.set(n, team);
  }
  const membersMissing = new Map<string, number>();
  const teamFailure = new Map<string, string>();
  for (const failure of state.failed) {
    if (failure.team === '*') continue;
    if (failure.reason === 'members_failed') {
      membersMissing.set(
        failure.team,
        (membersMissing.get(failure.team) ?? 0) + (failure.members?.length ?? 0)
      );
    } else if (failure.reason !== 'tag_failed') {
      teamFailure.set(failure.team, failure.reason);
    }
  }
  const stopped = state.failed.find(failure => failure.team === '*')?.reason ?? 'internal_error';

  // Failed name collisions: whether a classroom team holds the name.
  const collided = [...teamFailure]
    .filter(([, reason]) => reason === 'name_collision')
    .map(([name]) => predictTeamSlug(name));
  const heldSlugs = new Set(
    collided.length > 0
      ? (
          await getPrisma().team.findMany({
            where: { classroom_id: set.classroom_id, slug: { in: collided } },
            select: { slug: true },
          })
        ).map(team => team.slug.toLowerCase())
      : []
  );

  let next = state.status === 'RUNNING';
  const rows: CreateTeamProgress[] = planned.map((name, i) => {
    const n = i + 1;
    const size = sizes![i] ?? 0;
    const team = made.get(n);
    if (team) {
      return {
        n,
        name: team.name,
        state: 'done',
        members_added:
          team.members_added ?? Math.max(0, size - (membersMissing.get(team.name) ?? 0)),
        size,
        github_team: true,
      };
    }
    const failure = teamFailure.get(name);
    if (failure) {
      const held = failure === 'name_collision' && heldSlugs.has(predictTeamSlug(name));
      return { n, name, state: 'failed', members_added: 0, size, github_team: held, failure };
    }
    if (state.status === 'RUNNING') {
      const live = next;
      next = false;
      return {
        n,
        name,
        state: live ? 'live' : 'queued',
        members_added: 0,
        size,
        github_team: false,
      };
    }
    // Finished without it: the whole create stopped before this team.
    return {
      n,
      name,
      state: 'failed',
      members_added: 0,
      size,
      github_team: false,
      failure: stopped,
    };
  });
  const teams = order ? order.map((i, k) => ({ ...rows[i]!, n: k + 1 })) : rows;

  const names = await namesFor(set.classroom_id, [
    state.claimed_by,
    ...state.failed.flatMap(failure => (failure.members ?? []).map(member => member.user_id)),
  ]);
  return {
    status: state.status,
    run_number: state.run_number,
    attempt: state.attempt ?? 1,
    total: state.total,
    done: state.done,
    counts: state.counts ?? recount(state, 0, state.status !== 'RUNNING'),
    members_total: sizes.reduce((sum, size) => sum + size, 0),
    claimed_by: personRefOf(state.claimed_by, names),
    started_at: state.started_at,
    finished_at: state.finished_at,
    tag: { id: set.tag_id, name: set.name },
    teams,
    renamed: shown.renamed ?? [],
    failures: shown.failed.map(failure => ({
      team: failure.team,
      reason: failure.reason,
      ...(failure.members
        ? {
            members: failure.members.map(member => ({
              user_id: member.user_id,
              name: member.user_id ? (names.get(member.user_id) ?? null) : null,
              login: member.login,
              reason: member.reason,
            })),
          }
        : {}),
    })),
  };
}

/** A set's create for the pages (null before any claim), after lazy expiry. */
export async function getCreateProgress({
  classroomId,
  teamSetId,
}: {
  classroomId: string;
  teamSetId: string;
}): Promise<CreateProgressView | null> {
  const row = await expireLostCreate(await findSetScoped(classroomId, teamSetId));
  const state = readCreateState(row.create_state);
  return state ? createProgress(row, state) : null;
}

/**
 * Claim the set for one run's create and queue the apply task.
 *
 * A first claim is `updateMany … WHERE created_run_id IS NULL`; a retry of a
 * FAILED create is `updateMany … WHERE created_run_id = <the failed run> AND
 * create_state is that very FAILED attempt`. Either way two confirms that both
 * passed the checks race on one statement and exactly one wins; the loser is
 * told `create_in_progress` (or `already_created`).
 *
 * Every claim mints a fresh `attempt_id`. It goes into the apply task's
 * payload and idempotency key, so a claim that is released and made again
 * queues a NEW task rather than being handed the old one back, and a task of
 * a superseded attempt finds a different id in the row and does nothing.
 *
 * A retry keeps the teams the failed attempt made (and their member/tag
 * failures), records the teams it adopted from the tag, and drops the
 * failures of teams it will try again. It re-runs the GitHub pre-flight, so a
 * name GitHub now holds is suffixed exactly as the retry's preview showed.
 * The planned names are stored in the state, so applyCreate creates exactly
 * the names the preview showed.
 *
 * If the task cannot be queued the claim is RELEASED — back to unclaimed, or
 * back to the FAILED state it retried — and `trigger_unavailable` is thrown.
 *
 * `runId` may also be a run number; it is resolved through the set.
 */
export async function claimCreate({
  classroomId,
  teamSetId,
  runId,
  userId,
  githubTeams,
}: {
  classroomId: string;
  teamSetId: string;
  runId: string;
  userId: string;
  /** The Create dialog's checkbox; false is refused (see planCreate). */
  githubTeams?: boolean;
}): Promise<void> {
  const plan = await planCreate(classroomId, teamSetId, runId, githubTeams);
  if (!isTriggerConfigured()) {
    throw new TeamSetError(
      'trigger_unavailable',
      'Background jobs are not configured here, so teams cannot be created.'
    );
  }
  let names = plan.teams.map(team => team.name);
  if (plan.previous) {
    ({ names } = await githubPreflight({
      classroomId,
      names,
      fixed: indexesOf(plan.alreadyCreated),
      localTaken: plan.localTaken,
      retry: true,
    }));
  }

  const previous = plan.previous;
  const kept = plan.sameRun
    ? previous!.teams.map(team => ({
        ...team,
        n: team.n ?? plan.teams.find(t => t.name === team.name)?.n,
      }))
    : [];
  const teams: CreateState['teams'] = [...kept, ...plan.adopted];
  const existing = new Set(teams.map(team => team.name));
  const now = new Date().toISOString();
  const attemptId = randomUUID();
  // Masked grouping: the retry named the teams not made yet anew (planCreate),
  // so only what the pre-flight changed since counts as renamed — never a
  // name the last attempt planned.
  const renamed = !plan.sameRun
    ? []
    : plan.hideOption
      ? names.flatMap((to, i) => {
          const from = plan.teams[i]!.name;
          return from !== to ? [{ n: i + 1, from, to }] : [];
        })
      : renamedOnRetry(previous!, names);
  const state: CreateState = {
    status: 'RUNNING',
    run_id: plan.run.id,
    run_number: plan.run.number,
    total: plan.teams.length,
    done: plan.alreadyCreated.size,
    // A team that exists keeps its member/tag failures (they are still
    // missing); every other failure is of a team this attempt makes again.
    failed: plan.sameRun
      ? previous!.failed.filter(
          f =>
            f.team !== '*' &&
            existing.has(f.team) &&
            (f.reason === 'members_failed' || f.reason === 'tag_failed')
        )
      : [],
    teams,
    names,
    sizes: plan.teams.map(team => team.member_user_ids.length),
    ...(renamed.length > 0 ? { renamed } : {}),
    attempt: (previous?.attempt ?? (previous ? 1 : 0)) + 1,
    attempt_id: attemptId,
    claimed_by: userId,
    started_at: now,
    task_started_at: null,
    heartbeat_at: now,
    finished_at: null,
  };
  state.counts = recount(state, plan.sameRun ? (previous!.counts?.members_added ?? 0) : 0, false);

  const prisma = getPrisma();
  const claimed = await prisma.teamSet.updateMany({
    where: previous
      ? {
          id: plan.set.id,
          classroom_id: classroomId,
          created_run_id: plan.set.created_run_id,
          AND: [{ create_state: { path: ['status'], equals: 'FAILED' } }, attemptWhere(previous)],
        }
      : { id: plan.set.id, classroom_id: classroomId, created_run_id: null },
    data: { created_run_id: plan.run.id, create_state: toJson(state) },
  });
  if (claimed.count === 0) {
    const row = await prisma.teamSet.findUnique({
      where: { id: plan.set.id },
      select: { create_state: true },
    });
    const current = readCreateState(row?.create_state);
    if (current?.status === 'RUNNING') {
      throw new TeamSetError('create_in_progress', 'Teams for this set are being created now.');
    }
    throw new TeamSetError(
      'already_created',
      'Teams were already created from this set.',
      current ? { run_number: current.run_number, status: current.status } : undefined
    );
  }

  try {
    await tasks.trigger(
      APPLY_TASK_ID,
      { teamSetId: plan.set.id, attemptId },
      { idempotencyKey: `${APPLY_TASK_ID}:${plan.set.id}:${attemptId}` }
    );
  } catch (error) {
    console.error(`[teamSet] could not queue create for set ${plan.set.id}`, error);
    await prisma.teamSet.updateMany({
      where: { id: plan.set.id, created_run_id: plan.run.id, AND: [attemptWhere(state)] },
      data: previous
        ? { created_run_id: plan.set.created_run_id, create_state: toJson(previous) }
        : { created_run_id: null, create_state: Prisma.DbNull },
    });
    throw new TeamSetError(
      'trigger_unavailable',
      'The create could not be queued; nothing new was created.'
    );
  }
}

/** The WHERE that matches only this attempt's create, and only while it is RUNNING. */
const whileOursAndRunning = (teamSetId: string, state: CreateState): Prisma.TeamSetWhereInput => ({
  id: teamSetId,
  AND: [{ create_state: { path: ['status'], equals: 'RUNNING' } }, attemptWhere(state)],
});

/**
 * The FINAL create_state write failed even after its retries. applyCreate
 * lets it out (rather than turning it into yet another write that would fail
 * the same way), so the apply task's catch marks the create stopped.
 */
export class CreateStateWriteError extends Error {
  readonly code = 'state_write_failed';

  constructor() {
    super('The final create state could not be recorded.');
    this.name = 'CreateStateWriteError';
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * Persist progress — but only while the row still holds THIS attempt,
 * RUNNING. Every write refreshes `heartbeat_at`, which is what lazy expiry
 * counts from. A create that was stopped underneath it (canceled, or expired
 * as 'lost') must not be flipped back to RUNNING by a late write; in that case
 * what this attempt learned since its last write — the teams it made and every
 * failure it recorded (member-level ones included) — is merged into the
 * stopped state (its status untouched), because a retry can only skip teams it
 * knows exist and can only report failures it was told about.
 *
 * Returns false when the create is no longer ours; the caller stops.
 *
 * A PROGRESS write that hits a database error is logged (by set id only) and
 * swallowed: the teams it describes exist either way and the next write
 * carries them. The TERMINAL write is not allowed to vanish like that — a
 * create that finished while its row still says RUNNING would be expired as
 * 'lost' — so it is tried TERMINAL_WRITE_ATTEMPTS times with a short backoff,
 * and then throws `CreateStateWriteError`.
 */
async function writeCreateState(
  teamSetId: string,
  state: CreateState,
  { terminal = false }: { terminal?: boolean } = {}
): Promise<boolean> {
  state.heartbeat_at = new Date().toISOString();
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeCreateStateOnce(teamSetId, state);
    } catch (error) {
      console.error(
        `[teamSet] could not record ${terminal ? 'the final create state' : 'create progress'} for set ${teamSetId} (try ${attempt})`,
        errorName(error)
      );
      if (!terminal) return true;
      if (attempt >= TERMINAL_WRITE_ATTEMPTS) throw new CreateStateWriteError();
      await sleep(TERMINAL_WRITE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

async function writeCreateStateOnce(teamSetId: string, state: CreateState): Promise<boolean> {
  const prisma = getPrisma();
  const { count } = await prisma.teamSet.updateMany({
    where: whileOursAndRunning(teamSetId, state),
    data: { create_state: toJson(state) },
  });
  if (count > 0) return true;

  const row = await prisma.teamSet.findUnique({
    where: { id: teamSetId },
    select: { create_state: true },
  });
  const current = readCreateState(row?.create_state);
  if (!current || attemptOf(current) !== attemptOf(state)) return false;
  if (current.status === 'RUNNING') return true; // a concurrent write of ours; not stopped

  const known = new Set(current.teams.map(team => team.team_id));
  const extra = state.teams.filter(team => !known.has(team.team_id));
  const failureKey = (f: CreateFailure) => `${f.team}\u0000${f.reason}`;
  const recorded = new Set(current.failed.map(failureKey));
  const newFailures = state.failed.filter(f => f.team !== '*' && !recorded.has(failureKey(f)));
  if (extra.length > 0 || newFailures.length > 0) {
    const merged: CreateState = {
      ...current,
      teams: [...current.teams, ...extra],
      failed: [...current.failed, ...newFailures],
    };
    merged.counts = recount(
      merged,
      Math.max(current.counts?.members_added ?? 0, state.counts?.members_added ?? 0),
      true
    );
    await prisma.teamSet.updateMany({
      where: {
        id: teamSetId,
        AND: [
          { create_state: { path: ['status'], equals: current.status } },
          attemptWhere(current),
        ],
      },
      data: { create_state: toJson(merged) },
    });
  }
  return false;
}

/**
 * Mark a RUNNING create FAILED from outside `applyCreate` — the apply task's
 * cancel hook (`canceled`) or its last-resort catch (`internal_error`).
 * Conditional on the row still holding THAT task's attempt, RUNNING: a create
 * that finished, was retried under a new attempt, or belongs to another task
 * is left alone, and every team already recorded is kept. Returns whether it
 * wrote.
 */
export async function stopCreate({
  teamSetId,
  attemptId,
  reason,
}: {
  teamSetId: string;
  attemptId: string;
  reason: 'canceled' | 'internal_error';
}): Promise<boolean> {
  const prisma = getPrisma();
  const row = await prisma.teamSet.findUnique({
    where: { id: teamSetId },
    select: { create_state: true },
  });
  const state = readCreateState(row?.create_state);
  if (!state || state.status !== 'RUNNING' || attemptOf(state) !== attemptId) return false;
  const stopped: CreateState = {
    ...state,
    status: 'FAILED',
    failed: [...state.failed, { team: '*', reason }],
    finished_at: new Date().toISOString(),
  };
  stopped.counts = recount(stopped, state.counts?.members_added ?? 0, true);
  const { count } = await prisma.teamSet.updateMany({
    where: whileOursAndRunning(teamSetId, state),
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
 * Create the claimed run's teams. Called by the `team-set-apply` task with the
 * `attemptId` its claim minted.
 *
 * Ensures the Tag named after the set (and points `tag_id` at it), then, per
 * team in run order: `teamAdmin.createTeam` (visible, tagged, under the name
 * the claim stored) and `teamAdmin.addTeamMembers` by login. A team that fails
 * is recorded and the loop CONTINUES — half a class with teams beats none, and
 * every failure is listed. `create_state` is written after each team so
 * progress is readable while it runs. Ends DONE (every team, every member),
 * PARTIAL (every team exists; some members did not make it) or FAILED
 * (some team does not exist — the same run can be claimed again). Never
 * deletes: not a team, not a tag, not a membership.
 *
 * Its first act is to stamp `task_started_at` / `heartbeat_at`, so lazy expiry
 * counts from when the task started, not from the claim. A team the claim
 * ADOPTED (found on the tag, never recorded) is not made again; its members
 * are added again, which `addTeamMembers` makes idempotent.
 *
 * A no-op when the row holds a different attempt (this task's claim was
 * released or superseded) or the create is no longer RUNNING; teams already
 * recorded are skipped on re-entry. If the create is stopped underneath it
 * (stopCreate on cancel, or lazy expiry), the next progress write notices, the
 * teams made so far are merged into the stopped state, and no further team is
 * made. The FINAL write is retried and then thrown (`CreateStateWriteError`)
 * rather than swallowed, so the task's catch can mark the create stopped.
 */
export async function applyCreate({
  teamSetId,
  attemptId,
  onProgress,
}: {
  teamSetId: string;
  attemptId: string;
  onProgress?: (state: CreateState) => void;
}): Promise<CreateState> {
  const prisma = getPrisma();
  const set = await prisma.teamSet.findUnique({ where: { id: teamSetId } });
  const initial = readCreateState(set?.create_state);
  if (!set || !set.created_run_id || !initial) {
    throw new TeamSetError('not_found', 'No claimed create for this team set.');
  }
  if (attemptOf(initial) !== attemptId) {
    console.warn(`[teamSet] apply for set ${set.id} is not the current attempt; doing nothing`);
    return initial;
  }
  if (initial.status !== 'RUNNING') return initial;

  const state: CreateState = {
    ...initial,
    failed: [...initial.failed],
    teams: initial.teams.map(team => ({ ...team })),
  };
  let membersAdded = initial.counts?.members_added ?? 0;
  /** Write progress (or, finished, the final state); false once the create was stopped underneath us. */
  const report = async (finished = false): Promise<boolean> => {
    state.counts = recount(state, membersAdded, finished);
    const ours = await writeCreateState(set.id, state, { terminal: finished });
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

  // The task is alive: lazy expiry counts from here, not from the claim.
  state.task_started_at = state.task_started_at ?? new Date().toISOString();
  if (!(await report())) return stored();

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
    const adoptedAt = new Map(
      state.teams.filter(team => team.adopted && team.n).map(team => [team.n!, team])
    );

    /**
     * Add a team's members by login and record who could not be added. The
     * team exists by now: whatever happens here is a member-level failure,
     * never a reason to retry the team itself. Returns how many are on it.
     */
    const addMembers = async (team: (typeof teams)[number], teamId: string): Promise<number> => {
      let added = 0;
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
          const result = await teamAdminService.addTeamMembers({
            classroomId: set.classroom_id,
            slugOrId: teamId,
            logins,
          });
          membersAdded += result.succeeded.length;
          added = result.succeeded.length;
          failures = result.failed;
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
      return added;
    };

    for (const team of teams) {
      const adoptedEntry = adoptedAt.get(team.n);
      if (adoptedEntry) {
        // Made by an attempt that never recorded it, so its members may be
        // missing: add them again (idempotent), then it is an ordinary team.
        adoptedEntry.members_added = await addMembers(team, adoptedEntry.team_id);
        delete adoptedEntry.adopted;
        if (!(await report())) return await stored();
        continue;
      }
      if (alreadyCreated.has(team.n)) continue;

      // createTeam writes the team and its tag together or not at all (a tag
      // write that fails fails the team: db_error, or tag_required when the
      // set's tag is gone), so a made team always carries the set's tag.
      let entry: CreateState['teams'][number];
      try {
        const created = await teamAdminService.createTeam({
          classroomId: set.classroom_id,
          name: team.name,
          isVisible: true,
          tagIds: [tagId],
        });
        entry = { team_id: created.team.id, name: created.team.name, n: team.n };
        state.teams.push(entry);
      } catch (error) {
        console.error(`[teamSet] could not create team ${team.n} of set ${set.id}`, error);
        state.failed.push({ team: team.name, reason: teamFailureReason(error) });
        state.done += 1;
        if (!(await report())) return await stored();
        continue;
      }

      entry.members_added = await addMembers(team, entry.team_id);
      state.done += 1;
      // Stopped underneath (canceled, or expired as lost): make no more teams.
      if (!(await report())) return await stored();
    }

    if (state.teams.length < state.total) return await finish('FAILED');
    return await finish(state.failed.length > 0 ? 'PARTIAL' : 'DONE');
  } catch (error) {
    // The final write already failed every retry: another write would fail
    // the same way. Let it out, so the task's catch marks the create stopped.
    if (error instanceof CreateStateWriteError) throw error;
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
const SOLVE_STATUSES: ReadonlySet<string> = new Set([
  'OPTIMAL',
  'FEASIBLE',
  'INFEASIBLE',
  'UNKNOWN',
  'MODEL_INVALID',
]);
const ENGINE_VERSION = /^[a-z][a-z0-9_-]{0,15}@[0-9A-Za-z._-]{1,24}$/;

const isObjective = (value: unknown): value is number | null =>
  value === null || Number.isSafeInteger(value);
const isBound = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

/** A two-stage solve's `stages`, only in its exact shape (else undefined). */
function stagesOf(raw: unknown): TeamSetSolveStages | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { first, second } = raw as { first?: unknown; second?: unknown };
  const f = first as { status?: unknown; objective?: unknown; bound?: unknown } | null | undefined;
  if (!f || !SOLVE_STATUSES.has(f.status as string)) return undefined;
  if (!isObjective(f.objective) || !isBound(f.bound)) return undefined;
  let secondStage: TeamSetSolveStages['second'] = null;
  if (second !== null) {
    const s = second as { status?: unknown; objective?: unknown } | undefined;
    if (!s || !SOLVE_STATUSES.has(s.status as string) || !isObjective(s.objective)) {
      return undefined;
    }
    secondStage = { status: s.status as TeamSetSolveStatus, objective: s.objective };
  }
  return {
    first: { status: f.status as TeamSetSolveStatus, objective: f.objective, bound: f.bound },
    second: secondStage,
  };
}

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
  return { coreStatus, engine, stats, stages: stagesOf(solver.stages) };
}

/**
 * Where a two-stage answer disagrees with the scorer, as mismatch details
 * ([] = it agrees). A problem with a `group` must come with `stages`, and
 * each stage's objective must equal the scorer's part for it (stage 2's only
 * when stage 2 ran).
 */
function stageMismatches(
  problem: TeamSetProblem,
  stages: TeamSetSolveStages | undefined,
  parts: { first: number; second: number }
): { src: string | null; detail: string }[] {
  if (!problem.group) return [];
  if (!stages) return [{ src: null, detail: 'a problem with a group needs the engine’s stages' }];
  const out: { src: string | null; detail: string }[] = [];
  if (stages.first.objective !== parts.first) {
    out.push({
      src: null,
      detail: `stage 1 objective ${stages.first.objective} ≠ scored ${parts.first}`,
    });
  }
  if (stages.second !== null && stages.second.objective !== parts.second) {
    out.push({
      src: null,
      detail: `stage 2 objective ${stages.second.objective} ≠ scored ${parts.second}`,
    });
  }
  return out;
}

/**
 * Record the engine's answer.
 *
 * A solution is NOT trusted: it is rescored with `scoreAssignment`, which must
 * agree with the engine's objective exactly and find no violation — and, for a
 * two-stage solve (a problem with a `group`), whose per-stage parts must equal
 * the engine's `stages` (which such a problem must carry). Anything else is
 * `score_mismatch` — a disagreement between the two implementations of the
 * objective is a bug, and a proposal nobody can explain must not become teams.
 * A SOLVED run's metrics carry how people who didn't answer were placed.
 *
 * INFEASIBLE keeps the engine's unsat core as srcs with name-free labels
 * (labelSrc; names never enter a run's JSON — describeRun relabels on read),
 * plus one facts sentence (`summary`, infeasibleSummary): the listed settings
 * collide within the structural limits, the limits alone can't place
 * everyone, the core wasn't found in time, or — two-stage — the people who
 * didn't answer couldn't be seated after everyone else was.
 *
 * `engine` is replaced by the version the engine reports, when it reports
 * one; `core_status`, `stats` and `stages` are kept in `solver`.
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

  const { coreStatus, engine, stats, stages } = engineExtras(solver);
  const summary: SolverSummary = {
    status: solver.status,
    objective: solver.objective,
    bound: solver.bound,
    wall_s: solver.wall_s,
    ...(coreStatus ? { core_status: coreStatus } : {}),
    ...(stats ? { stats } : {}),
    ...(stages && run.problem.group ? { stages } : {}),
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
    const stageProblems = stageMismatches(run.problem, stages, scored.parts);
    if (
      solver.objective === null ||
      scored.objective !== solver.objective ||
      scored.violations.length > 0 ||
      stageProblems.length > 0
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
            violations: [...stageProblems, ...scored.violations].slice(0, 20),
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
    const { metrics } = computeMetrics(run.problem, run.context, teams, {
      nonRespondents: snapshotNonRespondents(run.config),
    });
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
    const srcs = [...new Set(Array.isArray(solver.core) ? solver.core : [])].filter(
      (src): src is string => typeof src === 'string'
    );
    const fields = await revisionFields(run.inputs.revision_id);
    const closed =
      srcs.length > 0
        ? closedProvenance(await runSetups(run.team_set_id, { upTo: run.number }), null, run.number)
        : new Map();
    // No names: a stored label counts people ("Pin: together — 3 students").
    // One entry per src as the engine gave it — per-student srcs too; the
    // views merge a rule's students into one line when they read it.
    const labelContext = { run, labels: labelsFor([fields], run.config), closed, fields };
    const core = srcs
      .map(src => labelSrc(src, labelContext))
      .map(item => ({
        src: item.src,
        label: item.label,
      }));
    return write({
      status: 'INFEASIBLE',
      solver: toJson(summary),
      diagnostics: toJson({
        ...previous,
        core,
        ...(coreStatus ? { core_status: coreStatus } : {}),
        summary: infeasibleSummary({
          core: core.length,
          ...(coreStatus ? { core_status: coreStatus } : {}),
          stages: run.problem.group ? (stages ?? null) : null,
          group: run.problem.group?.members.length ?? 0,
          free: run.config.grouping.mode === 'free',
        }),
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
