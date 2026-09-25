/**
 * Team-set tools — form_teams_get / form_teams_run / form_teams_create.
 *
 * A TEAM SET is one configured grouping of a CLASSROOM form's respondents
 * ("workshop-pairs"). A RUN solves the set's config against the form's current
 * responses and is only ever a proposal: it never touches a Team row. CREATE
 * turns one SOLVED, non-stale run into real teams (Classmoji + GitHub) under a
 * tag named after the set. All three are thin: every rule — config validation,
 * the pre-solve checks, staleness, the create refusals — lives in
 * `packages/services`' teamSet.service, which carries NO authorization by
 * documented design (the same stance formResponse.service takes). This file is
 * the gate in front of it.
 *
 * TIERS. Reading and running are the forms surface's work, so they take the
 * forms tier: FORMS_STAFF (OWNER | TEACHER — apps/pages' `assertFormAdmin`),
 * ASSISTANT excluded exactly as on every other forms tool, because a run's view
 * carries respondents' answers. CREATE is OWNER_ONLY: it mints real GitHub
 * teams in the classroom organization, and every team-writing tool in this
 * server (teams.ts) is owner-only for that reason. A teacher can therefore
 * shape and solve a set but cannot turn it into teams.
 *
 * THE PRO GATE APPLIES TO ALL THREE, READS INCLUDED, and it is the first act of
 * every handler — the forms surface does not exist on a free classroom, so
 * neither does anything built on top of it.
 *
 * THE USER SEES THE SETUP AND THE TEAMS FIRST — structurally, not only in the
 * descriptions:
 *   - the call that CREATES a set only saves it; it never starts a run, even
 *     with `start: true`. The response carries the setup and says to show it.
 *   - `check: true` saves nothing and starts nothing (service `checkPatch`).
 *   - form_teams_create without `confirm` previews and creates nothing.
 *   - a second set on a form is never made implicitly: a `name` that matches
 *     no set, on a form that already has one, needs `new_set: true`.
 *
 * S1 (classroom scoping). Every handler resolves the form through
 * `loadFormInClassroom` (shared.ts: form.classroom_id vs
 * ctx.classroom.classroomId, the uniform `scopedNotFound('Form')`) BEFORE the
 * service is called, and the service calls are then handed the AUTHORIZED
 * classroom id — never an argument — which the service scopes every query by.
 * A team set or run is only ever addressed through a form that has already
 * passed S1.
 *
 * PAYLOADS ARE ALLOW-LISTED. Run views name students (name + login) and quote
 * their free-text answers for fields with a note rule; previews name every
 * member of every team. Every payload below is rebuilt key by key from the
 * service's DTO — never spread — so a column or debugging field added upstream
 * cannot reach a client by default. No email address is ever echoed. A set's
 * config is echoed only where the caller is looking at the SETUP (get without
 * a run, a save that starts nothing, a check); run responses carry the set as
 * `{ id, name }`.
 *
 * ERRORS. The service throws `TeamSetError` with a closed `code` vocabulary.
 * Each code maps to a fixed ToolError kind and a short sentence written here;
 * the service's message text is never forwarded. The structured `details` a
 * caller can act on (a config's problem list, staleness reasons, colliding
 * team names, the names of the sets when the reference is ambiguous) are
 * forwarded through an explicit allow-list, because an agent cannot fix a
 * config it cannot see the problems with. Matched on `name` + `code`, not
 * `instanceof`, for the reason registry.ts gives for CALLER_ERROR_CODES.
 */

import { createHash } from 'node:crypto';
import { ClassmojiService, TeamSetConfigPatchSchema } from '@classmoji/services';
import type {
  CheckIssue,
  CreatePreview,
  CreateState,
  RunView,
  TeamSetConfigPatch,
  TeamSetMetrics,
  TeamSetRow,
} from '@classmoji/services';
import { TEAM_SET_JOB_FIELD_TYPES, TEAM_SET_JOB_PARAMS } from '@classmoji/services/team-set-config';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { assertProTier } from '../authz/proTier.ts';
import {
  FORMS_STAFF,
  OWNER_ONLY,
  loadFormInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
  type FormRecord,
} from './shared.ts';

/** Audit resource type — sits beside 'TEAMS' and 'FORMS'. */
const TEAM_SETS_RESOURCE = 'TEAM_SETS';

/**
 * A run call's whole budget, measured from handler entry: the connector's own
 * timeout is ~60 s, and saving, checking and queueing all happen before the
 * wait starts. The wait gets what is left minus the time to describe a result.
 */
const HANDLER_BUDGET_MS = 45_000;
const DESCRIBE_RESERVE_MS = 3_000;
const MAX_WAIT_S = 45;
const DEFAULT_WAIT_S = 40;

/** Runs listed by form_teams_get without a `run` argument (newest first). */
const RUNS_LISTED = 5;

/** A run in these states will not change again; anything else is still in flight. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'SOLVED',
  'INFEASIBLE',
  'FAILED',
  'CANCELED',
]);

// ─── Error mapping ──────────────────────────────────────────────────────────

type MappedKind = 'invalid_params' | 'not_found' | 'internal';

/**
 * Every TeamSetError code, with the kind and the sentence a caller sees. The
 * sentences are written for the agent relaying them to a teacher: what is
 * wrong and what to do next. `not_found` is absent: it becomes the uniform
 * `scopedNotFound(<what the call was looking for>)`.
 */
const TEAM_SET_ERRORS: ReadonlyMap<string, { kind: MappedKind; message: string }> = new Map([
  ['invalid_config', { kind: 'invalid_params', message: 'The config or set name is invalid' }],
  [
    'no_grouping_field',
    {
      kind: 'invalid_params',
      message: 'The grouping question is not a ranked-choice or dropdown on the current form',
    },
  ],
  [
    'form_not_classroom',
    { kind: 'invalid_params', message: 'Team sets need a CLASSROOM-access form' },
  ],
  [
    'checks_failed',
    { kind: 'invalid_params', message: 'The setup has blocking problems; see issues' },
  ],
  [
    'run_not_solved',
    { kind: 'invalid_params', message: 'Only a SOLVED run can be turned into teams' },
  ],
  [
    'run_stale',
    {
      kind: 'invalid_params',
      message: 'Answers or the roster changed since this run; start a new run',
    },
  ],
  [
    'already_created',
    {
      kind: 'invalid_params',
      message:
        'This set already has its teams; change them on the Teams screen, or make a new set to group differently',
    },
  ],
  [
    'create_in_progress',
    {
      kind: 'invalid_params',
      message: 'Teams for this set are being created now; follow with form_teams_get',
    },
  ],
  [
    'tag_conflict',
    {
      kind: 'invalid_params',
      message:
        'A tag with this set’s name already has teams; make a new set with another name (form_teams_run with name and new_set: true)',
    },
  ],
  [
    'github_teams_off_unsupported',
    { kind: 'invalid_params', message: 'github_teams: false is not supported yet' },
  ],
  [
    'github_unavailable',
    {
      kind: 'invalid_params',
      message:
        'The classroom’s GitHub organization cannot be reached; check the Classmoji app is installed on it',
    },
  ],
  [
    'name_collision',
    {
      kind: 'invalid_params',
      message:
        'Some team names are already teams in the GitHub organization (see names); change team_name_template and run again',
    },
  ],
  [
    'provider_unsupported',
    {
      kind: 'invalid_params',
      message:
        'Creating teams from a team set is GitHub only; this classroom’s organization is not on GitHub',
    },
  ],
  [
    'trigger_unavailable',
    { kind: 'internal', message: 'Background jobs are unavailable; nothing was created' },
  ],
]);

/**
 * A sharper sentence than the code's own, for the cases the service's
 * details tell apart. Null keeps the code's sentence.
 */
function refinedMessage(code: string, details: unknown): string | null {
  const record = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>;
  switch (code) {
    case 'already_created':
      // A FAILED create that made teams pins the set to its run: that run can
      // be retried, no other can. DONE/PARTIAL: the set simply has its teams.
      if (record.status === 'FAILED' && Number.isSafeInteger(record.run_number)) {
        const n = record.run_number as number;
        return `A create of run ${n} failed partway and made some teams; only run ${n} can be retried (form_teams_create with run: ${n})`;
      }
      return null;
    case 'run_stale':
      return record.retry_blocked === true
        ? 'People on the teams still to create have left the class, so this create cannot be retried; create the rest on the Teams screen, or make a new set'
        : null;
    case 'github_unavailable':
      return record.reason === 'timeout'
        ? 'GitHub did not answer in time while checking team names; nothing was created. Try again in a minute'
        : null;
    default:
      return null;
  }
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 50)
    : undefined;

/**
 * The details worth forwarding, by name and type. Everything else the service
 * attaches is dropped.
 */
function detailsData(details: unknown): Record<string, unknown> | undefined {
  // A config problem list may arrive bare (string[]).
  if (Array.isArray(details)) {
    const problems = strings(details);
    return problems?.length ? { problems } : undefined;
  }
  if (!details || typeof details !== 'object') return undefined;
  const record = details as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const problems = strings(record.problems);
  if (problems?.length) data.problems = problems;
  const reasons = strings(record.reasons);
  if (reasons?.length) data.reasons = reasons;
  // Team names (name_collision) — never people.
  const names = strings(record.names);
  if (names?.length) data.names = names;
  if (Array.isArray(record.issues)) {
    data.issues = record.issues
      .filter(
        (entry): entry is CheckIssue =>
          Boolean(entry) && typeof (entry as CheckIssue).code === 'string'
      )
      .slice(0, 50)
      .map(issuePayload);
  }
  if (typeof record.field_id === 'string') data.field_id = record.field_id;
  if (typeof record.status === 'string') data.status = record.status;
  if (Number.isSafeInteger(record.run_number)) data.run_number = record.run_number;
  // Closed markers the service sets: a pre-flight that ran out of time, a
  // same-run retry blocked by someone who left.
  if (record.reason === 'timeout') data.reason = 'timeout';
  if (record.retry_blocked === true) data.retry_blocked = true;
  return Object.keys(data).length ? data : undefined;
}

/**
 * Translate a TeamSetError into its ToolError; anything else is returned for
 * rethrow (it surfaces as `internal`). `what` names the thing a `not_found`
 * was about, for the uniform S1 sentence.
 */
function mapTeamSetError(error: unknown, what: string): unknown {
  const named = error as { name?: unknown; code?: unknown; details?: unknown } | null;
  if (!named || named.name !== 'TeamSetError' || typeof named.code !== 'string') return error;

  if (named.code === 'not_found') {
    // The one not_found a caller answers differently: several sets on the form
    // and no reference. The names let the agent ask which one.
    const details = named.details as { reason?: unknown; names?: unknown } | undefined;
    if (details?.reason === 'ambiguous') {
      return new ToolError(
        'invalid_params',
        'This form has several team sets; pass team_set',
        'team_set_ambiguous',
        { team_sets: strings(details.names) ?? [] }
      );
    }
    return scopedNotFound(what);
  }

  const mapped = TEAM_SET_ERRORS.get(named.code);
  if (!mapped) return error;
  return new ToolError(
    mapped.kind,
    refinedMessage(named.code, named.details) ?? mapped.message,
    named.code,
    detailsData(named.details)
  );
}

/** Run a service call, mapping its documented refusals. */
async function withTeamSetRules<T>(run: () => Promise<T>, what = 'Team set'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapTeamSetError(error, what);
  }
}

// ─── S1 loader ──────────────────────────────────────────────────────────────

/**
 * The shared S1 form loader (shared.ts), plus the one refusal only this
 * surface makes: a form that was never published has no field list to
 * configure against. The service refuses it too, but only here can the
 * refusal say so precisely.
 */
async function loadPublishedForm(formId: string, ctx: ToolContext): Promise<FormRecord> {
  const form = await loadFormInClassroom(formId, ctx);
  if (!form.current_revision_id) {
    throw new ToolError(
      'invalid_params',
      'Publish the form before setting up teams',
      'form_not_published'
    );
  }
  return form;
}

// ─── Payload allow-lists ────────────────────────────────────────────────────

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

/** What to do about a check code whose message alone does not say. */
const CHECK_HINTS: Readonly<Record<string, string>> = {
  model_too_large: 'Remove a match or mix rule, or group teams by a question, then run again.',
  count_contradiction:
    'Remove max_per_team: 1 from that no_one_alone rule (or remove the rule), then run again.',
  odd_group_in_pairs:
    'Set team_size.allow_one_larger: true, or make that rule prefer instead of must.',
};

/** A check issue; `names` arrive only from calls that already show people. */
function issuePayload(issue: CheckIssue & { names?: string[] }) {
  const hint = CHECK_HINTS[issue.code];
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(hint ? { hint } : {}),
    ...(issue.srcs ? { srcs: issue.srcs } : {}),
    ...(issue.user_ids ? { user_ids: issue.user_ids } : {}),
    ...(strings(issue.names)?.length ? { names: strings(issue.names) } : {}),
  };
}

type CreateStatus = 'none' | 'running' | 'done' | 'partial' | 'failed';

/** One word for where a set's create stands; `create_state` has the detail. */
function createStatus(set: {
  created_run_id?: string | null;
  create_state?: CreateState | null;
}): CreateStatus {
  const status = set.create_state?.status;
  if (status === 'RUNNING') return 'running';
  if (status === 'DONE') return 'done';
  if (status === 'PARTIAL') return 'partial';
  if (status === 'FAILED') return 'failed';
  return set.created_run_id ? 'running' : 'none';
}

const count = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : 0);

function createStatePayload(state: CreateState | null | undefined) {
  if (!state) return null;
  return {
    status: state.status,
    run_number: state.run_number ?? null,
    attempt: state.attempt ?? 1,
    total: state.total ?? null,
    done: state.done ?? null,
    ...(state.counts
      ? {
          counts: {
            teams_created: count(state.counts.teams_created),
            teams_failed: count(state.counts.teams_failed),
            members_added: count(state.counts.members_added),
            members_failed: count(state.counts.members_failed),
          },
        }
      : {}),
    failed: (state.failed ?? []).map(entry => ({
      team: entry.team,
      reason: entry.reason,
      ...(entry.members
        ? {
            members: entry.members.map(member => ({
              user_id: member.user_id,
              login: member.login ?? null,
              reason: member.reason,
            })),
          }
        : {}),
    })),
    teams: (state.teams ?? []).map(entry => ({ team_id: entry.team_id, name: entry.name })),
    started_at: iso(state.started_at),
    finished_at: iso(state.finished_at),
  };
}

const PLACEMENT_KEYS = ['1', '2', '3', '4', '5+', 'fallback', 'missed', 'no_answer'] as const;

function metricsPayload(metrics: TeamSetMetrics | null | undefined) {
  if (!metrics) return null;
  // `matches` is optional in the metrics module; `avoids` is absent on runs
  // solved before it existed. Both are read through a structural widening.
  const extra = metrics as TeamSetMetrics & {
    avoids?: { total?: number; broken?: number };
    matches?: { pairs?: number; mismatched?: number };
  };
  return {
    people: metrics.people,
    responded: metrics.responded,
    teams: metrics.teams,
    options_open: metrics.options_open,
    options_total: metrics.options_total,
    placement: Object.fromEntries(PLACEMENT_KEYS.map(key => [key, metrics.placement?.[key] ?? 0])),
    first_choice: metrics.first_choice,
    top2: metrics.top2,
    requests: {
      total: metrics.requests?.total ?? 0,
      kept: metrics.requests?.kept ?? 0,
      mutual_pairs: metrics.requests?.mutual_pairs ?? 0,
      mutual_pairs_kept: metrics.requests?.mutual_pairs_kept ?? 0,
    },
    avoids: { total: count(extra.avoids?.total), broken: count(extra.avoids?.broken) },
    ...(extra.matches
      ? {
          matches: {
            pairs: count(extra.matches.pairs),
            mismatched: count(extra.matches.mismatched),
          },
        }
      : {}),
    must_broken: metrics.must_broken,
  };
}

/** The short form used in the runs list. */
function metricsSummary(metrics: TeamSetMetrics | null | undefined) {
  if (!metrics) return null;
  return {
    people: metrics.people,
    teams: metrics.teams,
    first_choice: metrics.first_choice,
    top2: metrics.top2,
    requests_kept: metrics.requests?.kept ?? 0,
    requests_total: metrics.requests?.total ?? 0,
    must_broken: metrics.must_broken,
  };
}

/** What a failed run's error means for the caller's next step. */
const RUN_ERROR_NEXT: Readonly<Record<string, string>> = {
  trigger_unavailable:
    'Background jobs are unavailable here, so nothing was solved; try again later.',
  engine_error: 'The solver failed; run again, and report it if it keeps failing.',
  score_mismatch: 'The solver’s answer failed verification and was discarded; run again.',
  no_solution_in_time:
    'No grouping was found within the time limit; raise time_limit_s or loosen must rules, then run again.',
  model_invalid:
    'The solver rejected this setup; remove match/mix rules or loosen must rules, then run again.',
  canceled: 'This run was canceled; start a new run.',
  lost: 'The background solve stopped without an answer; start a new run.',
  queue_expired: 'The run waited too long to start; start a new run.',
};

/** Where the set's create stands, as nextForRun needs it for a SOLVED run. */
interface CreateContext {
  status: CreateStatus;
  /** The run the set's create is (or was) of. */
  runNumber: number | null;
  /** That run is the one being described. */
  thisRun: boolean;
  /** Teams that create has made so far. */
  teamsMade: number;
}

function createContext(
  set: { created_run_id?: string | null; create_state?: CreateState | null },
  runId: string
): CreateContext {
  return {
    status: createStatus(set),
    runNumber: Number.isSafeInteger(set.create_state?.run_number)
      ? set.create_state!.run_number
      : null,
    thisRun: Boolean(set.created_run_id) && set.created_run_id === runId,
    teamsMade: set.create_state?.teams?.length ?? 0,
  };
}

/**
 * The next step for a SOLVED run of a set whose create has started, or null
 * when the set has no create that constrains it. It comes before staleness: a
 * set with teams cannot take another create whatever the run says, and a
 * same-run retry is allowed even when the run has gone stale.
 */
function createNext(runNumber: number, create: CreateContext | undefined): string | null {
  if (!create || create.status === 'none') return null;
  const from = create.thisRun
    ? 'this run'
    : create.runNumber !== null
      ? `run ${create.runNumber}`
      : 'another run';
  switch (create.status) {
    case 'running':
      return `Teams for this set are being created now (from ${from}); follow with form_teams_get and don't create again.`;
    case 'done':
      return `Teams were already created from this set (${from}); nothing is left to create. To group differently, make a new set (form_teams_run with name and new_set: true).`;
    case 'partial':
      return `Teams were already created from this set (${from}), but some members or tags are missing (see create_state): fix those on the Teams screen. To group differently, make a new set.`;
    case 'failed':
      if (create.thisRun) {
        return `Creating these teams failed partway (see create_state). To finish, preview again with form_teams_create (run: ${runNumber}) and confirm only after the user approves; teams already made are skipped.`;
      }
      if (create.teamsMade > 0) {
        return `A create of ${from} failed partway and made some teams; only that run can be retried (form_teams_create with run: ${create.runNumber ?? 'that run'}).`;
      }
      // Failed before making any team: any run may be created.
      return null;
    default:
      return null;
  }
}

/** One sentence: what the caller does next with this run. */
function nextForRun(
  run: {
    number: number;
    status: string;
    stale?: boolean;
    error?: string | null;
  },
  create?: CreateContext
): string {
  switch (run.status) {
    case 'QUEUED':
    case 'RUNNING':
      return `Still solving. Poll form_teams_get with run: ${run.number}; don't start another run.`;
    case 'SOLVED':
      return (
        createNext(run.number, create) ??
        (run.stale
          ? 'Answers or the roster changed since this run: start a new run before creating teams.'
          : `Show these teams to the user. To make them real, an owner previews with form_teams_create (run: ${run.number}) and confirms only after the user approves.`)
      );
    case 'INFEASIBLE':
      return 'No grouping meets every must rule and pin: relax or remove one of those in core (or the size limits), then run again.';
    case 'CANCELED':
      return 'This run was canceled; start a new run.';
    default:
      return RUN_ERROR_NEXT[run.error ?? ''] ?? 'This run failed; start a new run.';
  }
}

const CORE_STATUSES: ReadonlySet<string> = new Set(['complete', 'timeout', 'n/a']);

function runViewPayload(view: RunView, create?: CreateContext) {
  // Closed vocabulary (complete | timeout | n/a); anything else is dropped.
  const coreStatus =
    typeof view.solver?.core_status === 'string' && CORE_STATUSES.has(view.solver.core_status)
      ? view.solver.core_status
      : undefined;
  return {
    id: view.id,
    number: view.number,
    status: view.status,
    ...(view.error ? { error: view.error } : {}),
    created_at: iso(view.created_at),
    finished_at: iso(view.finished_at),
    solver: view.solver
      ? {
          status: view.solver.status,
          objective: view.solver.objective ?? null,
          bound: view.solver.bound ?? null,
          wall_s: view.solver.wall_s ?? null,
          ...(coreStatus ? { core_status: coreStatus } : {}),
        }
      : null,
    metrics: metricsPayload(view.metrics),
    stale: view.stale,
    stale_reasons: view.stale_reasons ?? [],
    issues: (view.issues ?? []).map(issuePayload),
    core: (view.core ?? []).map(entry => ({ src: entry.src, label: entry.label })),
    // Beside the INFEASIBLE sentence: whether its core is the whole story
    // ('complete') or the solver ran out of time narrowing it ('timeout').
    ...(view.summary
      ? { summary: view.summary, ...(coreStatus ? { core_status: coreStatus } : {}) }
      : {}),
    teams: (view.teams ?? []).map(team => ({
      n: team.n,
      name: team.name,
      option: team.option ? { id: team.option.id, label: team.option.label } : null,
      size: team.size,
      members: (team.members ?? []).map(member => ({
        user_id: member.user_id,
        name: member.name ?? null,
        login: member.login ?? null,
        placement: member.placement ?? null,
        requests_kept: member.requests_kept,
        requests_total: member.requests_total,
        ...(member.notes?.length
          ? {
              notes: member.notes.map(note => ({
                field_label: note.field_label,
                text: note.text,
              })),
            }
          : {}),
      })),
    })),
    next: nextForRun(view, create),
  };
}

/** A set named in a run response: no config (that is the setup view's). */
const setRef = (set: { id: string; name: string }) => ({ id: set.id, name: set.name });

/** A set as its SETUP: the thing a caller shows the user and patches. */
function setupPayload(set: TeamSetRow) {
  return {
    id: set.id,
    name: set.name,
    // The set's own JSON, parsed through the strict TeamSetConfigSchema on
    // every read: the thing a caller patches, so it is echoed whole.
    config: set.config,
    create_status: createStatus(set),
    create_state: createStatePayload(set.create_state),
  };
}

function previewPayload(preview: CreatePreview) {
  return {
    run_id: preview.run_id,
    run_number: preview.run_number,
    tag: { name: preview.tag.name, exists: preview.tag.exists },
    github_teams: preview.github_teams,
    ...(preview.retry
      ? {
          retry: {
            attempt: count(preview.retry.attempt),
            teams_already_created: count(preview.retry.teams_already_created),
          },
        }
      : {}),
    teams: preview.teams.map(team => ({
      name: team.name,
      option: team.option ? { id: team.option.id, label: team.option.label } : null,
      members: team.members.map(member => ({
        user_id: member.user_id,
        name: member.name ?? null,
        login: member.login ?? null,
      })),
    })),
    warnings: strings(preview.warnings) ?? [],
  };
}

/**
 * How to write a patch — static, so it costs the tool manifest nothing. The
 * per-job tables are the config module's own, so they cannot drift from the
 * validator.
 */
const PATCH_HELP = {
  shape: 'form_teams_run patch = a partial config; keys left out stay as they are.',
  rules:
    'rules: { upsert: [{ field_id, job, strength?: off|prefer|must, weight?: 1-10, params? }], remove: [{ field_id, job }] }. ' +
    'A rule is keyed by field_id + job; strength is required only when the rule is new; params merge, and null clears one param.',
  params_by_job: TEAM_SET_JOB_PARAMS,
  field_types_by_job: TEAM_SET_JOB_FIELD_TYPES,
  pins:
    'pins: { add: [pin without id], remove: [pin ids], clear: true }. Kinds: ' +
    '{ kind: "together", user_ids: 2-12 }, { kind: "apart", user_ids: exactly 2 }, ' +
    '{ kind: "on_option", user_id, option_id }, { kind: "not_options", user_id, option_ids }; each may carry reason. ' +
    'Ids are assigned (p1, p2, …); adding a pin identical to an existing one is skipped.',
  options:
    'options: { <grouping option id>: { open?: auto|open|closed, category?: <a fallback option label>, team_name?: <short name for {option}> } | null }. ' +
    'null removes that option’s settings; a single field set to null clears just that field.',
  other:
    'grouping { mode: "by_option", field_id, teams_per_option } | { mode: "free" }; team_size { min, max, allow_one_larger }; ' +
    'team_count { min?, max? }; non_respondents include|exclude; fairness 0-100; ' +
    'team_name_template with {set} {n} {option}; time_limit_s 5-120.',
} as const;

// ─── Shared input schemas ───────────────────────────────────────────────────

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const formIdArg = z.string().uuid().describe('Form id');
const teamSetArg = z
  .string()
  .min(1)
  .max(100)
  .describe('Team set name or id; needed only when the form has several');
const runRefArg = z
  .union([z.number().int().min(1), z.string().min(1).max(64)])
  .describe('Run number (e.g. 3) or run id');

const teamSets = () => ClassmojiService.teamSet;

/**
 * The set a reference names: an id or a name, or — with no reference — the
 * form's only set. Null when there is none; `team_set_ambiguous` when there
 * are several and no reference.
 */
function resolveSet(
  classroomId: string,
  formId: string,
  setRef: string | undefined
): Promise<TeamSetRow | null> {
  return withTeamSetRules(() =>
    teamSets().getSet({ classroomId, formId, ...(setRef !== undefined ? { setRef } : {}) })
  );
}

/**
 * The newest runs of a set, newest first, each SOLVED one with its staleness
 * (staleness only decides whether a solved run can still be created). One
 * light read: the service computes every listed run's staleness from a single
 * read of the form's current state.
 */
async function recentRuns(classroomId: string, teamSetId: string) {
  const rows = await withTeamSetRules(() =>
    teamSets().listRuns({ classroomId, teamSetId, limit: RUNS_LISTED, withStaleness: true })
  );
  return rows.map(row => ({
    number: row.number,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    created_at: iso(row.created_at),
    finished_at: iso(row.finished_at),
    metrics: metricsSummary(row.metrics),
    stale: row.status === 'SOLVED' ? (row.stale ?? null) : null,
  }));
}

// ─── form_teams_get ─────────────────────────────────────────────────────────

interface FormTeamsGetArgs {
  classroom: string;
  form_id: string;
  team_set?: string;
  run?: number | string;
  include_people?: boolean;
}

export const formTeamsGetTool: ToolDefinition<FormTeamsGetArgs> = {
  name: 'form_teams_get',
  title: 'Get team sets for a form',
  description:
    'Reads the team sets of a CLASSROOM form: groupings of its respondents into teams, solved ' +
    'from their answers. Staff only (owner or teacher); requires Pro.\n' +
    'Without run: the form’s sets, the chosen set’s config (its setup) and create_status, a ' +
    'suggested config when no set exists yet, readiness (roster, responded, not responded), ' +
    'recent runs with summary metrics and a stale flag, and patch_help (how to write a ' +
    'form_teams_run patch).\n' +
    'With run: that run’s proposed teams (members with name, login, placement, requests kept, ' +
    'noted answers), metrics, check issues, for an infeasible run the rules that collide, the ' +
    'create progress, and next (what to do now).\n' +
    'Contains student names and free-text answers; audit-logged.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: FORMS_STAFF,
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    team_set: teamSetArg.optional(),
    run: runRefArg.optional(),
    include_people: z
      .boolean()
      .optional()
      .describe('With run: include the members of each team (default true)'),
  },
  handler: async (args, ctx) => {
    await assertProTier(ctx);
    const { classroomId } = requireClassroomCtx(ctx);
    const form = await loadPublishedForm(args.form_id, ctx);
    const service = teamSets();

    if (args.run !== undefined) {
      const runRef = args.run;
      const set = await resolveSet(classroomId, form.id, args.team_set);
      if (!set) throw scopedNotFound('Team set');
      const run = await withTeamSetRules(
        () => service.getRun({ classroomId, teamSetId: set.id, runRef }),
        'Run'
      );
      const includePeople = args.include_people ?? true;
      const view = await withTeamSetRules(() =>
        service.describeRun({ classroomId, run, includePeople })
      );

      if (includePeople && view.teams.length > 0) {
        // Members' names and quoted answers are other people's submissions —
        // the reason forms.ts audits its response reads as VIEW rows.
        await writeAudit(ctx, {
          resource_type: TEAM_SETS_RESOURCE,
          resource_id: run.id,
          action: 'VIEW',
          data: {
            tool: 'form_teams_get',
            form_id: form.id,
            team_set_id: set.id,
            run_number: run.number,
          },
        });
      }

      return ok({
        team_set: setRef(set),
        run: runViewPayload(view, createContext(set, run.id)),
        created_from_this_run: set.created_run_id === run.id,
        create_status: createStatus(set),
        create_state: createStatePayload(set.create_state),
      });
    }

    const summaries = await withTeamSetRules(() =>
      service.listForForm({ classroomId, formId: form.id })
    );
    // Several sets and no reference: list them rather than refuse.
    const ambiguous = summaries.length > 1 && args.team_set === undefined;
    const set =
      summaries.length > 0 && !ambiguous
        ? await resolveSet(classroomId, form.id, args.team_set)
        : null;
    if (args.team_set !== undefined && !set) throw scopedNotFound('Team set');

    const suggested =
      summaries.length === 0
        ? await withTeamSetRules(() => service.suggestForForm({ classroomId, formId: form.id }))
        : null;

    // The service's inputs are the roster and the roster's SUBMITTED responses.
    const inputs = await withTeamSetRules(() =>
      service.loadInputs({ classroomId, formId: form.id })
    );
    const roster = new Set(inputs.roster.map(member => member.user_id));
    const responded = new Set(
      inputs.responses.map(response => response.user_id).filter(id => roster.has(id))
    ).size;

    const summary = set ? summaries.find(entry => entry.id === set.id) : undefined;
    const runs = set ? await recentRuns(classroomId, set.id) : [];

    return ok({
      team_sets: summaries.map(entry => ({
        id: entry.id,
        name: entry.name,
        create_status: createStatus(entry),
        run_count: entry.run_count,
        latest_run: entry.latest_run
          ? { number: entry.latest_run.number, status: entry.latest_run.status }
          : null,
      })),
      set: set ? setupPayload(set) : null,
      ...(ambiguous
        ? { hint: 'This form has several team sets; pass team_set to choose one' }
        : {}),
      ...(suggested
        ? {
            suggested_config: suggested.config,
            suggested_name: suggested.name,
            next: 'Show the suggested setup to the user in plain words. form_teams_run saves it (without running); run it with start: true once they agree.',
          }
        : {}),
      readiness: { roster: roster.size, responded, not_responded: roster.size - responded },
      runs,
      ...(summary && summary.run_count > runs.length
        ? { runs_omitted: summary.run_count - runs.length }
        : {}),
      patch_help: PATCH_HELP,
    });
  },
};

// ─── form_teams_run ─────────────────────────────────────────────────────────

interface FormTeamsRunArgs {
  classroom: string;
  form_id: string;
  team_set?: string;
  name?: string;
  new_set?: boolean;
  patch?: Record<string, unknown>;
  check?: boolean;
  start?: boolean;
  wait_s?: number;
}

/** Issues listed when a patch is refused; enough to fix it, short enough to read. */
const MAX_PATCH_PROBLEMS = 10;

/**
 * Validate a patch against the services' TeamSetConfigPatchSchema.
 *
 * WHY HERE AND NOT IN THE INPUT SCHEMA: the full patch schema renders to ~4.6 KB
 * of JSON Schema in tools/list, and every tool on this server shares one
 * manifest budget. The tool advertises a plain object instead and points the
 * agent at form_teams_get's config and patch_help for the shape; the same
 * schema is enforced here, before anything is read or written, and a refusal
 * lists the zod issue paths so the agent can correct the patch.
 */
function parsePatch(raw: Record<string, unknown>): TeamSetConfigPatch {
  const parsed = TeamSetConfigPatchSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues
    .slice(0, MAX_PATCH_PROBLEMS)
    .map(issue => `${['patch', ...issue.path].join('.')}: ${issue.message}`);
  const more = parsed.error.issues.length - problems.length;
  throw new ToolError(
    'invalid_params',
    'The patch does not match the config shape; see problems',
    'invalid_config',
    { problems: more > 0 ? [...problems, `…and ${more} more`] : problems }
  );
}

/**
 * A short, stable fingerprint of a patch for the audit row's `value`: the
 * audit service coalesces rows of one tool on one resource within five
 * seconds unless their values differ, and two quick edits are two acts.
 */
const patchFingerprint = (patch: TeamSetConfigPatch | undefined): string =>
  createHash('sha256')
    .update(JSON.stringify(patch ?? {}))
    .digest('hex')
    .slice(0, 12);

const FIRST_RUN_NEXT =
  'This set is new, so nothing was run. Show the user this setup (grouping, team size, rules, pins) in plain words, then call again with start: true once they agree.';

export const formTeamsRunTool: ToolDefinition<FormTeamsRunArgs> = {
  name: 'form_teams_run',
  // Saves a config and queues a solve. A run is a proposal: no team, member or
  // GitHub object is created or removed, and nothing leaves the database — so
  // NOT destructive and closed-world. NOT idempotent: every start is a new run.
  annotations: { destructive: false, idempotent: false, openWorld: false },
  title: 'Configure and run a team set',
  description:
    'Saves a team set’s config for a CLASSROOM form and solves it against the current responses. ' +
    'Staff only (owner or teacher); requires Pro.\n' +
    'patch is a partial config (see form_teams_get’s config and patch_help): rules {upsert, remove} ' +
    'keyed by field_id + job (strength off/prefer/must, weight 1-10), pins {add, remove, clear}, ' +
    'options, team_size, grouping. Jobs: rank, fallback, owner, together/apart (roster_select), ' +
    'match/mix, balance, no_one_alone, note.\n' +
    'The call that creates a set (the form’s first, or name + new_set: true for another) only ' +
    'saves it and never runs: show the user the setup in plain words, then call again with ' +
    'start: true after they agree.\n' +
    'check: true saves and starts nothing; it returns the would-be config and its issues. A run ' +
    'is a proposal and never creates teams (form_teams_create does). If the call times out or ' +
    'returns a run number, poll with form_teams_get; don’t start another run.',
  scope: 'write',
  roles: FORMS_STAFF,
  // One bucket for every call — the registry cannot tell a check or a
  // start: false save from a start — so it is sized for an agent iterating on
  // a setup (check, patch, check again) with a solve among them: 30 burst, one
  // every two seconds sustained. The solve queue's own concurrency limit (5)
  // is what bounds the CPU.
  rateLimit: { capacity: 30, refillPerSecond: 0.5 },
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    team_set: teamSetArg.optional(),
    name: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('Name for a NEW set (default from the form title); or names an existing set'),
    new_set: z
      .boolean()
      .optional()
      .describe('With name: make ANOTHER set on a form that already has one'),
    // A plain object on the wire; parsePatch enforces the real schema.
    patch: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Partial config (see form_teams_get patch_help); omit to use it as saved'),
    check: z.boolean().optional().describe('Validate only: saves nothing, starts nothing'),
    start: z
      .boolean()
      .optional()
      .describe('Start a run (default true for an existing set; a new set never starts)'),
    wait_s: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_S)
      .optional()
      .describe(`Seconds to wait for the result (default ${DEFAULT_WAIT_S})`),
  },
  handler: async (args, ctx) => {
    // The wait is budgeted from HERE: everything before it counts.
    const entry = Date.now();
    await assertProTier(ctx);
    const { classroomId } = requireClassroomCtx(ctx);
    // A malformed patch costs no query: refused before the form is read.
    const patch = args.patch !== undefined ? parsePatch(args.patch) : undefined;
    if (args.new_set && (args.name === undefined || args.team_set !== undefined)) {
      throw new ToolError(
        'invalid_params',
        'new_set needs name (the new set’s name) and no team_set',
        'invalid_config'
      );
    }
    const form = await loadPublishedForm(args.form_id, ctx);
    const service = teamSets();
    const userId = ctx.viewer.userId;

    // Which set this call is about — resolved the way saveConfig picks it: the
    // reference, else the name, else the form's only set.
    const existing = await resolveSet(classroomId, form.id, args.team_set ?? args.name);
    if (args.team_set !== undefined && !existing) throw scopedNotFound('Team set');
    if (existing && args.new_set) {
      throw new ToolError(
        'invalid_params',
        'A set with this name already exists on this form; pass team_set to edit it',
        'set_exists',
        { team_sets: [existing.name] }
      );
    }
    if (!existing && args.name !== undefined && !args.new_set) {
      // A name that matches nothing, on a form that already has sets, would
      // silently make a second set. Only on request.
      const others = await withTeamSetRules(() =>
        service.listForForm({ classroomId, formId: form.id })
      );
      if (others.length > 0) {
        throw new ToolError(
          'invalid_params',
          'This form already has a team set; pass team_set to edit it, or new_set: true to make another',
          'new_set_required',
          { team_sets: others.map(other => other.name).slice(0, 50) }
        );
      }
    }
    const isNew = !existing;

    // ── check: in memory only ──
    if (args.check) {
      const checked = await withTeamSetRules(() =>
        service.checkPatch({
          classroomId,
          formId: form.id,
          ...(existing
            ? { setRef: existing.id }
            : args.name !== undefined
              ? { name: args.name }
              : {}),
          ...(patch !== undefined ? { patch } : {}),
        })
      );
      const blocking = checked.issues.some(issue => issue.level === 'error');
      return ok({
        checked: true,
        saved: false,
        started: false,
        team_set: existing ? setRef(existing) : null,
        name: checked.name,
        config: checked.config,
        ...(checked.notes.length ? { notes: checked.notes } : {}),
        issues: checked.issues.map(issuePayload),
        next: blocking
          ? 'Blocking problems (level error): change the patch and check again.'
          : isNew
            ? 'No blocking problems. Show the user this setup; calling again without check saves it (a new set is not run on that call).'
            : 'No blocking problems. Call again without check to save this patch and start a run.',
      });
    }

    // ── save, audited at once — whatever happens to a run afterwards ──
    const saved = await withTeamSetRules(() =>
      service.saveConfig({
        classroomId,
        formId: form.id,
        ...(existing ? { setRef: existing.id } : {}),
        ...(!existing && args.name !== undefined ? { name: args.name } : {}),
        ...(patch !== undefined ? { patch } : {}),
        userId,
      })
    );
    const patched = patch ? Object.keys(patch) : [];
    if (isNew || patched.length > 0) {
      await writeAudit(ctx, {
        resource_type: TEAM_SETS_RESOURCE,
        resource_id: saved.id,
        action: isNew ? 'CREATE' : 'UPDATE',
        data: {
          tool: 'form_teams_run',
          form_id: form.id,
          name: saved.name,
          patched,
          value: patchFingerprint(patch),
        },
      });
    }
    const notes = strings(saved.notes) ?? [];

    if (isNew) {
      return ok({
        team_set: setupPayload(saved),
        set_created: true,
        started: false,
        ...(args.start === true
          ? { start_refused: 'A new set is never run on the call that creates it.' }
          : {}),
        ...(notes.length ? { notes } : {}),
        next: FIRST_RUN_NEXT,
      });
    }
    if (args.start === false) {
      return ok({
        team_set: setupPayload(saved),
        set_created: false,
        started: false,
        ...(notes.length ? { notes } : {}),
        next: 'Saved. Call again with start: true to run it.',
      });
    }

    const { run, issues } = await withTeamSetRules(() =>
      service.startRun({ classroomId, teamSetId: saved.id, userId })
    );

    if (!run) {
      return ok({
        team_set: setRef(saved),
        started: false,
        ...(notes.length ? { notes } : {}),
        issues: issues.map(issuePayload),
        next: 'The setup has blocking problems (issues); fix them with a patch, then run again.',
      });
    }

    // resource_id is the RUN, not the set: the audit service coalesces rows on
    // (resource, tool) within five seconds, and two quick runs are two acts.
    await writeAudit(ctx, {
      resource_type: TEAM_SETS_RESOURCE,
      resource_id: run.id,
      action: 'CREATE',
      data: {
        tool: 'form_teams_run',
        form_id: form.id,
        team_set_id: saved.id,
        name: saved.name,
        run_number: run.number,
      },
    });

    const waitCapMs = Math.min(
      (args.wait_s ?? DEFAULT_WAIT_S) * 1000,
      HANDLER_BUDGET_MS - DESCRIBE_RESERVE_MS
    );
    const timeoutMs = Math.max(0, entry + waitCapMs - Date.now());
    const latest =
      timeoutMs > 0 && !TERMINAL_STATUSES.has(run.status)
        ? await withTeamSetRules(
            () => service.waitForRun({ classroomId, runId: run.id, timeoutMs }),
            'Run'
          )
        : run;

    if (!TERMINAL_STATUSES.has(latest.status)) {
      return ok({
        team_set: setRef(saved),
        started: true,
        run: { number: latest.number, status: latest.status },
        ...(notes.length ? { notes } : {}),
        next: nextForRun(latest),
        ...(issues.length ? { issues: issues.map(issuePayload) } : {}),
      });
    }

    const view = await withTeamSetRules(() =>
      service.describeRun({ classroomId, run: latest, includePeople: true })
    );
    return ok({
      team_set: setRef(saved),
      started: true,
      ...(notes.length ? { notes } : {}),
      run: runViewPayload(view, createContext(saved, latest.id)),
    });
  },
};

// ─── form_teams_create ──────────────────────────────────────────────────────

interface FormTeamsCreateArgs {
  classroom: string;
  form_id: string;
  team_set?: string;
  run: number | string;
  confirm?: true;
}

const PREVIEW_NOTICE =
  'Nothing was created. Show this to the user and call again with confirm: true only after they approve.';

export const formTeamsCreateTool: ToolDefinition<FormTeamsCreateArgs> = {
  name: 'form_teams_create',
  // Creates real GitHub teams in the classroom organization (openWorld) and
  // cannot be undone by any tool → destructive, so a client pauses for a human.
  annotations: { destructive: true, idempotent: false, openWorld: true },
  title: 'Create teams from a team-set run',
  description:
    'Turns one SOLVED run of a team set into real teams: a Classmoji team and a GitHub team for ' +
    'each, with its members, all tagged with the set’s name. Owner only; requires Pro.\n' +
    'Without confirm it returns a preview and creates nothing. ALWAYS show the user that preview ' +
    '(team names and members) and get their explicit approval before calling again with ' +
    'confirm: true.\n' +
    'Refused when the run is not solved, is stale (answers or roster changed since; start a new ' +
    'run), a team name is taken on GitHub, or the set’s teams were already created. Creation ' +
    'runs in the background: follow it with form_teams_get (create_status, create_state). A ' +
    'create that failed can be previewed and confirmed again for the same run; teams already ' +
    'made are skipped. Nothing is deleted, and there is no undo tool.',
  scope: 'write',
  roles: OWNER_ONLY,
  // Previews and confirms share one bucket (the registry cannot tell them
  // apart). A preview probes GitHub once per team, and a confirm can only
  // succeed once per set (the claim is atomic), so the burst allows several
  // preview → fix → preview rounds; one every ten seconds sustained.
  rateLimit: { capacity: 12, refillPerSecond: 0.1 },
  inputSchema: {
    classroom: classroomArg,
    form_id: formIdArg,
    team_set: teamSetArg.optional(),
    run: runRefArg,
    confirm: z
      .literal(true)
      .optional()
      .describe('Only after the user approved the preview; omit to preview'),
  },
  handler: async (args, ctx) => {
    await assertProTier(ctx);
    const { classroomId } = requireClassroomCtx(ctx);
    const form = await loadPublishedForm(args.form_id, ctx);
    const service = teamSets();

    const set = await resolveSet(classroomId, form.id, args.team_set);
    if (!set) throw scopedNotFound('Team set');

    if (args.confirm !== true) {
      const preview = await withTeamSetRules(
        () => service.previewCreate({ classroomId, teamSetId: set.id, runRef: args.run }),
        'Run'
      );
      return ok({ created: false, preview: previewPayload(preview), notice: PREVIEW_NOTICE });
    }

    const run = await withTeamSetRules(
      () => service.getRun({ classroomId, teamSetId: set.id, runRef: args.run }),
      'Run'
    );
    // claimCreate re-validates everything previewCreate checks (solved, not
    // stale, not already created, tag free) and claims the set atomically.
    await withTeamSetRules(() =>
      service.claimCreate({
        classroomId,
        teamSetId: set.id,
        runId: run.id,
        userId: ctx.viewer.userId,
      })
    );
    const teams = run.result?.teams.length ?? 0;

    await writeAudit(ctx, {
      resource_type: TEAM_SETS_RESOURCE,
      resource_id: set.id,
      action: 'CREATE',
      data: {
        tool: 'form_teams_create',
        form_id: form.id,
        name: set.name,
        run_id: run.id,
        run_number: run.number,
        teams,
      },
    });

    return ok({
      started: true,
      teams,
      next: 'Creating teams in the background. Follow progress with form_teams_get (create_status, create_state).',
    });
  },
};
