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
 * PEOPLE ARE AUDITED OR ABSENT. Every response that names students is written
 * down as a VIEW row first: a run read with people, a comparison with people,
 * the run a form_teams_run call finished with, a check or a refused start
 * whose issues name someone, and a create preview. `include_people: false`
 * carries no person at all — no member, no user id or name on an issue or a
 * Can't-solve item (nor who closed its option), create failures only as
 * counts, movers only as a count — so it needs no row. The setup view (no
 * run) carries none either, beyond the pins' user ids in the config it
 * echoes for patching.
 *
 * IDENTITY QUESTIONS (a field flagged `identity_question` on the form). Their
 * answers never reach any payload here: the service strips them from notes,
 * why facts and comparisons, and this file forwards only the aggregate —
 * "held on N of M teams" per identity rule. Which teams missed is the page's
 * "Show which", on explicit request; no tool here asks for it
 * (`revealIdentity` is never passed), and a `missed_teams` list is dropped
 * even if one arrives. Check issues about an identity rule never carry people.
 *
 * STAMPS. Every write passes `via: 'mcp'`, so a pin added or an option closed
 * through a tool is shown as such on the page ("· over MCP").
 *
 * A SET LOCKS once its create is claimed (the service's `set_locked`): no
 * save, run or revert after that. Grouping differently is a new set, copied
 * from this one with `copy_from`.
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
  CoreItem,
  CreatePreview,
  CreateState,
  OptionRef,
  OptionStatus,
  PersonRef,
  PinView,
  PlacementFacts,
  PriorityFact,
  RunComparisonView,
  RunMover,
  RunView,
  SetupChange,
  TeamSetConfigPatch,
  TeamSetMetricsView,
  TeamSetRow,
  TeamSetRowView,
  TeamSetStatus,
  TeamSignals,
} from '@classmoji/services';
import {
  DEFAULT_PRIORITY_SHIFT,
  IDENTITY_QUESTION_JOBS,
  OPTION_NOTE_MAX_CHARS,
  PRIORITY_TARGET_JOBS,
  TEAM_SET_JOB_FIELD_TYPES,
  TEAM_SET_JOB_PARAMS,
  TEAM_SET_NON_RESPONDENTS,
  withoutRetiredKeys,
} from '@classmoji/services/team-set-config';
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
  [
    'invalid_config',
    {
      kind: 'invalid_params',
      message:
        'The config or set name is invalid; see problems (paths say where each is). A pin a problem names (paths pins.<id>) can be dropped with pins.remove',
    },
  ],
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
        'This set already has its teams; change them on the Teams screen, or group differently in a new set (form_teams_run with copy_from and new_set: true)',
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
    // Classroom-only teams are not made (yet): every create makes GitHub teams.
    'github_teams_off_unsupported',
    {
      kind: 'invalid_params',
      message:
        'github_teams: false is not supported yet; patch github_teams: true, run again, then create from the new run',
    },
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
  [
    // The set's create was claimed: its setup, runs and create are fixed.
    'set_locked',
    {
      kind: 'invalid_params',
      message:
        'This set’s teams exist, so its setup can’t change and it can’t run again. To group differently, start a new set from this one (form_teams_run with copy_from and new_set: true)',
    },
  ],
  [
    'run_in_progress',
    {
      kind: 'invalid_params',
      message:
        'A run of this set hasn’t finished, so no run was started (a patch, if any, was saved). Poll it with form_teams_get, then run again',
    },
  ],
  [
    'name_taken',
    {
      kind: 'invalid_params',
      message:
        'This form already has a team set with that name; pass team_set to edit it, or choose another name',
    },
  ],
  [
    // A save or a revert waited for the set past its limit (another save or a
    // run's start held it). Nothing was written either way.
    'set_busy',
    {
      kind: 'invalid_params',
      message:
        'Another save or run held this set, so this change was not saved; call again with the same arguments',
    },
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
    case 'set_locked': {
      // RUNNING (or a claim with no state yet): the create is under way.
      if (record.status === 'RUNNING' || record.status === null) {
        return 'Teams are being created from this set now, so its setup is fixed; follow with form_teams_get';
      }
      const n = Number.isSafeInteger(record.run_number) ? (record.run_number as number) : null;
      if (record.status === 'FAILED' && n !== null) {
        return `A create of run ${n} failed partway, so this set’s setup is fixed. Retry it with form_teams_create (run: ${n}), or group differently in a new set (form_teams_run with copy_from and new_set: true)`;
      }
      return n !== null
        ? `This set’s teams were created from run ${n}, so its setup can’t change and it can’t run again. To group differently, start a new set from this one (form_teams_run with copy_from and new_set: true)`
        : null;
    }
    case 'run_in_progress': {
      if (!Number.isSafeInteger(record.run_number)) return null;
      const n = record.run_number as number;
      return `Run ${n} of this set hasn’t finished, so no run was started (a patch, if any, was saved). Poll form_teams_get with run: ${n}, then run again`;
    }
    case 'set_busy':
      // A run's start that ran out of time (the patch, if any, was saved before it).
      return record.action === 'run'
        ? 'Another save or run held this set, so no run was started (a patch, if any, was saved); call form_teams_run again'
        : null;
    case 'name_taken':
      return typeof record.name === 'string'
        ? `This form already has a team set named "${record.name}"; pass team_set: "${record.name}" to edit it, or choose another name`
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
  if (problems?.length) {
    data.problems = problems;
    // Where each problem is (index-aligned; '' = the setup as a whole).
    const paths = strings(record.paths);
    if (paths?.length === problems.length) data.paths = paths;
  }
  const reasons = strings(record.reasons);
  if (reasons?.length) data.reasons = reasons;
  // Team names (name_collision) — never people.
  const names = strings(record.names);
  if (names?.length) data.names = names;
  // A set's name (name_taken) — never a person's.
  if (typeof record.name === 'string') data.name = record.name;
  if (Array.isArray(record.issues)) {
    // An error is not audited as a read: its issues carry no person.
    data.issues = record.issues
      .filter(
        (entry): entry is CheckIssue =>
          Boolean(entry) && typeof (entry as CheckIssue).code === 'string'
      )
      .slice(0, 50)
      .map(issue => issuePayload(issue, false));
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

/**
 * A taken set name, found before the service is asked: the same code, sentence
 * and details as the service's own `name_taken`.
 */
const nameTakenError = (name: string): ToolError =>
  new ToolError(
    'invalid_params',
    refinedMessage('name_taken', { name }) ?? TEAM_SET_ERRORS.get('name_taken')!.message,
    'name_taken',
    { name }
  );

/** Run a service call, mapping its documented refusals. */
async function withTeamSetRules<T>(run: () => Promise<T>, what = 'Team set'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapTeamSetError(error, what);
  }
}

/**
 * compareRuns' `run_not_solved`, in its own words: the code's sentence is
 * about creating teams, and a comparison needs both runs solved.
 */
function compareRefusal(error: unknown): never {
  const named = error as { name?: unknown; code?: unknown; details?: unknown } | null;
  if (named?.name === 'TeamSetError' && named.code === 'run_not_solved') {
    const details = (named.details ?? {}) as { run_number?: unknown; status?: unknown };
    const n = Number.isSafeInteger(details.run_number) ? (details.run_number as number) : null;
    const status = typeof details.status === 'string' ? details.status : null;
    throw new ToolError(
      'invalid_params',
      n !== null && status !== null
        ? `Run ${n} is ${status}; only SOLVED runs can be compared`
        : 'Only SOLVED runs can be compared',
      'run_not_solved',
      { ...(n !== null ? { run_number: n } : {}), ...(status ? { status } : {}) }
    );
  }
  throw error;
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

/**
 * What to do about each check code. The checks' messages are facts only (the
 * page shows them as they are); the advice is the agent's, and lives here —
 * one entry for every error and warning code the checks module can emit, plus
 * the config refusals the service reports as check issues.
 */
const CHECK_HINTS: Readonly<Record<string, string>> = {
  no_people:
    'Nobody is left to place: add students to the roster, or set non_respondents to include, then run again.',
  capacity:
    'Change team_size (min, max), team_count or grouping.teams_per_option, or open or close options, so everyone fits (the fewest teams may already be one person over or under their size). When the message counts the teams left after those for the people who didn’t answer (Group), choosing Spread (non_respondents: include) gives the people who answered every team.',
  model_too_large: 'Remove a match or mix rule, or group teams by a question, then run again.',
  all_options_forbidden:
    'Remove or loosen the not_options pins or must rules in srcs, or open a closed option, so each person keeps at least one option.',
  conflicting_required_options:
    'Keep one required option per person: remove one of the pins or must rules in srcs.',
  pinned_option_closed:
    'Set that option back to auto or open (options.<id>.open), or remove the pin that places people on it.',
  required_option_forbidden:
    'Remove either the pin or rule that puts this person on the option or the one that keeps them off it (see srcs).',
  required_pair_forbidden:
    'Remove the together or the apart pin in srcs, or make one of the two rules prefer.',
  together_group_too_large:
    'Split the together pins, make the together rule prefer, or raise team_size.max (or that option’s size.max).',
  count_contradiction:
    'Remove max_per_team: 1 from that no_one_alone rule (or remove the rule), then run again.',
  option_capacity_pins:
    'Move some of those people to other options (pins), raise that option’s size.max or grouping.teams_per_option, or make the owner rule prefer.',
  owner_no_pitcher:
    'Set that option back to auto, let one of its pitchers onto it (remove the pin or must rule that keeps them off), or make the owner rule prefer.',
  group_too_small:
    'Too few people didn’t answer to fill a team of their own: choose Spread (non_respondents: include) or Leave out (non_respondents: exclude).',
  group_no_option:
    'People who didn’t answer are seated only on teams left after everyone else: set a closed option back to auto, give an option that always runs a second team (grouping.teams_per_option), make the owner rule prefer (at must, an option runs only with one of its pitchers, who answered), or choose Spread (include) or Leave out (exclude).',
  group_split:
    'Change team_size, or open more options (set a closed one back to auto, raise grouping.teams_per_option, or make a must owner rule prefer), so the people who didn’t answer can form teams of their own, or choose Spread (non_respondents: include) or Leave out (exclude).',
  no_response:
    'Remind them to answer, or choose how they are placed: non_respondents include (spread over the teams), group (seated with each other after everyone else) or exclude (left out).',
  forced_open_unranked:
    'Set those options back to auto unless they should run even though nobody ranked them.',
  pin_people_missing:
    'Those people are not in this set (left the roster, or left out as non-respondents); remove the pin with pins.remove, or leave it (the rest still applies).',
  odd_group_in_pairs:
    'Each odd no_one_alone group needs a team of 3, and pairs get only as many as the count needs: make that rule prefer instead of must, or raise team_size.max above 2.',
  identity_single_answer:
    'An answer only one student gave can’t have company on any team, so the rule can’t hold for that student whatever the setup; nothing needs changing. An answer that shouldn’t count goes in the rule’s wildcard_option_ids. Never try to work out who gave it.',
  identity_rule_pairs:
    'Rules on identity questions are skipped when teams are pairs; raise team_size.max above 2 for it to apply.',
  priority_target_off:
    'Turn on the rules the priority rule points at (srcs), point rule_a / rule_b at active rules, or turn the priority rule off.',
  invalid_config:
    'Change the setup so it fits the current form; a pin a problem names (srcs pin:<id>) can be dropped with pins.remove.',
  no_grouping_field:
    'Group by a ranked-choice or dropdown question on the current form (grouping.field_id), or use grouping { mode: "free" }.',
};

/** Check codes about an identity rule: never tied to a person, whatever arrives. */
const IDENTITY_CHECK_CODES: ReadonlySet<string> = new Set([
  'identity_single_answer',
  'identity_rule_pairs',
]);

/**
 * A check issue; `names` arrive only from calls that already show people.
 * `withPeople` false drops its people (user ids and names) whatever arrives:
 * a view without people carries none.
 */
function issuePayload(issue: CheckIssue & { names?: string[] }, withPeople = true) {
  const hint = CHECK_HINTS[issue.code];
  const people = withPeople && !IDENTITY_CHECK_CODES.has(issue.code);
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(hint ? { hint } : {}),
    ...(issue.srcs ? { srcs: issue.srcs } : {}),
    ...(strings(issue.option_ids)?.length ? { option_ids: strings(issue.option_ids) } : {}),
    ...(people && issue.user_ids ? { user_ids: issue.user_ids } : {}),
    ...(people && strings(issue.names)?.length ? { names: strings(issue.names) } : {}),
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

/**
 * A set's create. `withPeople` false (the setup view, a run read with
 * include_people: false): who couldn't be added is a count per failure,
 * never a user id or login.
 */
function createStatePayload(state: CreateState | null | undefined, withPeople = true) {
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
      ...(entry.members && !withPeople ? { members_failed: entry.members.length } : {}),
      ...(entry.members && withPeople
        ? {
            members: entry.members.map(member => ({
              user_id: member.user_id,
              login: member.login ?? null,
              reason: member.reason,
            })),
          }
        : {}),
    })),
    // Per team made: its position, and members added of its size.
    teams: (state.teams ?? []).map(entry => {
      const n = Number.isSafeInteger(entry.n) ? (entry.n as number) : null;
      const size = n !== null ? state.sizes?.[n - 1] : undefined;
      return {
        team_id: entry.team_id,
        name: entry.name,
        ...(n !== null ? { n } : {}),
        ...(Number.isSafeInteger(entry.members_added)
          ? { members_added: entry.members_added }
          : {}),
        ...(Number.isSafeInteger(size) ? { size } : {}),
      };
    }),
    // Teams a retry renamed because their planned name was taken.
    ...(state.renamed?.length
      ? {
          renamed: state.renamed.map(entry => ({ n: entry.n, from: entry.from, to: entry.to })),
        }
      : {}),
    started_at: iso(state.started_at),
    finished_at: iso(state.finished_at),
  };
}

const PLACEMENT_KEYS = ['1', '2', '3', '4', '5+', 'fallback', 'missed', 'no_answer'] as const;

/**
 * Top-3 placements; derived from `placement` on runs scored before `top3`
 * existed. null for free teams (no picks: the service sends null placement).
 */
const top3Of = (metrics: TeamSetMetricsView): number | null => {
  if (Number.isSafeInteger(metrics.top3)) return metrics.top3 as number;
  if (!metrics.placement) return null;
  return (
    count(metrics.placement['1']) + count(metrics.placement['2']) + count(metrics.placement['3'])
  );
};

/** A pick count as the service sends it: null for free teams. */
const pickCount = (value: number | null | undefined): number | null =>
  Number.isSafeInteger(value) ? (value as number) : null;

function metricsPayload(metrics: TeamSetMetricsView | null | undefined) {
  if (!metrics) return null;
  // `matches` is optional in the metrics module; `avoids` is absent on runs
  // solved before it existed. Both are read through a structural widening.
  const extra = metrics as TeamSetMetricsView & {
    avoids?: { total?: number; broken?: number };
    matches?: { pairs?: number; mismatched?: number };
  };
  return {
    people: metrics.people,
    responded: metrics.responded,
    teams: metrics.teams,
    options_open: metrics.options_open,
    options_total: metrics.options_total,
    // Free teams have no picks: placement and the pick counts are null.
    placement: metrics.placement
      ? Object.fromEntries(PLACEMENT_KEYS.map(key => [key, metrics.placement?.[key] ?? 0]))
      : null,
    first_choice: pickCount(metrics.first_choice),
    top2: pickCount(metrics.top2),
    top3: top3Of(metrics),
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
function metricsSummary(metrics: TeamSetMetricsView | null | undefined) {
  if (!metrics) return null;
  return {
    people: metrics.people,
    teams: metrics.teams,
    first_choice: pickCount(metrics.first_choice),
    top2: pickCount(metrics.top2),
    top3: top3Of(metrics),
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
      return `Teams were already created from this set (${from}); nothing is left to create. To group differently, start a new set from this one (form_teams_run with copy_from and new_set: true).`;
    case 'partial':
      return `Teams were already created from this set (${from}), but some members or tags are missing (see create_state): fix those on the Teams screen. To group differently, start a new set from this one (copy_from with new_set: true).`;
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

/** What the next step looks at on a run: its outcome, and for INFEASIBLE, why. */
interface RunOutcome {
  number: number;
  status: string;
  stale?: boolean;
  error?: string | null;
  core?: readonly { src: string }[];
  solver?: { core_status?: string } | null;
  non_respondents?: { mode: string } | null;
}

const INFEASIBLE_NEXT =
  'No grouping meets every must rule and pin: relax or remove one of those in core (or the size limits), then run again.';

/**
 * The advice for an INFEASIBLE run — the page's sentence is facts only
 * (`summary`); what to change is the agent's to say. Group mode seats people
 * who didn't answer only after everyone else, so it fails on its own terms.
 */
function infeasibleNext(run: RunOutcome): string {
  const core = run.core ?? [];
  const coreStatus = run.solver?.core_status;
  if (
    run.non_respondents?.mode === 'group' &&
    (core.length === 0 || core.some(item => item.src === 'non_respondents'))
  ) {
    return 'The people who didn’t answer can’t be seated with each other on the options left after everyone else was placed: choose Spread (non_respondents: include) or Leave out (exclude), or open more options or raise their size, then run again.';
  }
  if (core.length === 0 && coreStatus === 'complete') {
    return 'The size limits alone can’t place everyone: change team_size, team_count or grouping.teams_per_option (or open more options), then run again.';
  }
  if (core.length === 0 && coreStatus === 'timeout') {
    return 'No grouping meets every must rule and pin, and the solver ran out of time before finding which collide: raise time_limit_s, or make must rules prefer, then run again.';
  }
  return core.length > 0 && coreStatus === 'timeout'
    ? `${INFEASIBLE_NEXT} The solver ran out of time narrowing the list, so some settings in core may not be part of the conflict.`
    : INFEASIBLE_NEXT;
}

/** One sentence: what the caller does next with this run. */
function nextForRun(run: RunOutcome, create?: CreateContext): string {
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
      return infeasibleNext(run);
    case 'CANCELED':
      return 'This run was canceled; start a new run.';
    default:
      return RUN_ERROR_NEXT[run.error ?? ''] ?? 'This run failed; start a new run.';
  }
}

const CORE_STATUSES: ReadonlySet<string> = new Set(['complete', 'timeout', 'n/a']);

// ─── Compact texts ──────────────────────────────────────────────────────────

/** 1st, 2nd, 3rd, 4th, … 11th, 12th, 13th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** An option by its label, quoted; one no longer on the form by its id. */
const optionText = (option: OptionRef): string =>
  option.label !== null ? `'${option.label}'` : `option ${option.id} (no longer on the form)`;

/** A person by name, else their user id. */
const personText = (person: PersonRef): string => person.name ?? person.user_id;

/** How a run left an option: "closed", "full 4 of 4", "running 3 of 5", … */
function statusText(status: OptionStatus): string {
  switch (status.status) {
    case 'closed':
      return 'closed';
    case 'not_running':
      return 'not running';
    case 'full':
      return `full ${status.placed} of ${status.max}`;
    case 'running':
      return `running ${status.placed} of ${status.max}`;
    default:
      return 'no longer on the form';
  }
}

/** Where a person sat in one run: "'Ledger', team 2, 1st pick", or "team 3" in free mode. */
function seatText(seat: RunMover['from']): string {
  if (!seat.option) return `team ${seat.team_n}`;
  const rank = seat.rank !== null ? `${ordinal(seat.rank)} pick` : 'not ranked';
  return `${optionText(seat.option)}, team ${seat.team_n}, ${rank}`;
}

/** A pin, compactly: kind, the people (names), the option(s), the reason. */
function pinPayload(pin: PinView) {
  return {
    id: pin.id,
    kind: pin.kind,
    people: pin.people.map(personText),
    ...(pin.option ? { option: optionText(pin.option) } : {}),
    ...(pin.options?.length ? { options: pin.options.map(optionText) } : {}),
    ...(pin.reason ? { reason: pin.reason } : {}),
  };
}

/**
 * The texts of setup changes. With `namesFree`, a pin change is rewritten
 * without its people (the service's pin texts always name them): the setup
 * view is not audited, and names belong only in the views that are.
 */
function changeTexts(changes: readonly SetupChange[] | null | undefined, namesFree = false) {
  return (changes ?? []).map(change => {
    if (!namesFree || change.kind !== 'pin') return change.text;
    const pin = change.pin;
    const people = pin?.people?.length ?? 0;
    const option = pin?.option
      ? ` ${optionText(pin.option)}`
      : pin?.options?.length
        ? ` ${pin.options.map(optionText).join(', ')}`
        : '';
    return `Pin ${change.pin_id} ${change.change}: ${pin?.kind ?? 'pin'}${option}, ${people} ${people === 1 ? 'person' : 'people'}`;
  });
}

/**
 * One Can't-solve entry: the rule-only label, the people it names and who is
 * paired with whom (only with `withPeople`), and what to patch. Without
 * people, an option's closed_by is left out too.
 */
function coreItemPayload(item: CoreItem, withPeople = true) {
  const option = item.option;
  return {
    src: item.src,
    label: item.label,
    // Per-student srcs: the label is the rule's only; the students are here.
    ...(!withPeople
      ? {}
      : item.people?.length
        ? { people: item.people.map(person => ({ user_id: person.user_id, name: person.name })) }
        : item.user_ids?.length
          ? { user_ids: item.user_ids }
          : {}),
    // Pair srcs: [[0, 1], [2, 3]] = people[0] with people[1], people[2] with people[3].
    ...(withPeople && item.people?.length && item.pairs?.length
      ? {
          pairs: item.pairs
            .filter(
              pair =>
                Array.isArray(pair) &&
                pair.length === 2 &&
                pair.every(i => Number.isSafeInteger(i) && i >= 0 && i < item.people!.length)
            )
            .map(([a, b]) => [a, b]),
        }
      : {}),
    ...(option
      ? {
          option: {
            id: option.id,
            label: option.label,
            open: option.open,
            ...(option.note ? { note: option.note } : {}),
            ...(option.closed
              ? {
                  closed: {
                    since_run: option.closed.since_run,
                    ...(withPeople
                      ? { by: option.closed.by ? personText(option.closed.by) : null }
                      : {}),
                    via: option.closed.via,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(item.link?.field_id ? { field_id: item.link.field_id } : {}),
    ...(item.link?.option_id ? { option_id: item.link.option_id } : {}),
    ...(item.link?.pin_id ? { pin_id: item.link.pin_id } : {}),
  };
}

/** A team card's signals, from the run's own data. */
function signalsPayload(signals: TeamSignals | null | undefined) {
  if (!signals) return null;
  return {
    wanted_first: signals.wanted_first,
    seats: { used: count(signals.seats?.used), max: count(signals.seats?.max) },
    pitcher_on_team: signals.pitcher_on_team,
    requests: { kept: count(signals.requests?.kept), total: count(signals.requests?.total) },
    pinned: count(signals.pinned),
    did_not_answer: count(signals.did_not_answer),
    fourth_or_lower: count(signals.fourth_or_lower),
    ...(signals.balance?.length
      ? {
          balance: signals.balance.map(entry => ({
            question: entry.label,
            team_avg: entry.team_avg,
            class_avg: entry.class_avg,
          })),
        }
      : {}),
  };
}

/**
 * A run as a caller reads it. `withPeople` false (include_people: false)
 * carries no person at all — no members, no user id or name on an issue or a
 * Can't-solve item — so a read without people needs no audit.
 */
function runViewPayload(view: RunView, create?: CreateContext, withPeople = true) {
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
          gap_pct: view.solver.gap_pct ?? null,
          wall_s: view.solver.wall_s ?? null,
          ...(coreStatus ? { core_status: coreStatus } : {}),
        }
      : null,
    metrics: metricsPayload(view.metrics),
    // Identity rules as the aggregate ONLY: never which teams missed, never whose answer.
    ...(view.identity_rules?.length
      ? {
          identity_rules: view.identity_rules.map(rule => ({
            question: rule.label,
            teams_held: rule.teams_held,
            teams_total: rule.teams_total,
          })),
        }
      : {}),
    ...(view.non_respondents
      ? {
          non_respondents: { mode: view.non_respondents.mode, people: view.non_respondents.people },
        }
      : {}),
    stale: view.stale,
    stale_reasons: view.stale_reasons ?? [],
    // The set's setup now against this run's (names only in a view with people).
    changes_since_run: changeTexts(view.changes_since_run),
    ...(view.changes_from_previous
      ? {
          changes_from_previous: {
            run: view.changes_from_previous.since_run,
            changes: changeTexts(view.changes_from_previous.items),
          },
        }
      : {}),
    issues: (view.issues ?? []).map(issue => issuePayload(issue, withPeople)),
    core: (view.core ?? []).map(item => coreItemPayload(item, withPeople)),
    // Beside the INFEASIBLE sentence: whether its core is the whole story
    // ('complete') or the solver ran out of time narrowing it ('timeout').
    ...(view.summary
      ? { summary: view.summary, ...(coreStatus ? { core_status: coreStatus } : {}) }
      : {}),
    ...(view.option_status?.length
      ? {
          option_status: view.option_status.map(row => ({
            option_id: row.option_id,
            label: row.label,
            status: row.status,
            placed: row.placed,
            max: row.max,
          })),
        }
      : {}),
    teams: (view.teams ?? []).map(team => ({
      n: team.n,
      name: team.name,
      option: team.option ? { id: team.option.id, label: team.option.label } : null,
      size: team.size,
      signals: signalsPayload(team.signals),
      members: (withPeople ? (team.members ?? []) : []).map(member => ({
        user_id: member.user_id,
        name: member.name ?? null,
        login: member.login ?? null,
        placement: member.placement ?? null,
        rank: member.rank ?? null,
        pinned: member.pinned === true,
        responded: member.responded !== false,
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

/** One person who moved between two runs: seats, the pin and the requests that moved them. */
function moverPayload(mover: RunMover) {
  return {
    user_id: mover.user.user_id,
    name: mover.user.name,
    from: seatText(mover.from),
    to: seatText(mover.to),
    ...(mover.pin
      ? { pin: { id: mover.pin.pin_id, kind: mover.pin.kind, reason: mover.pin.reason } }
      : {}),
    ...(mover.requests.length
      ? {
          requests: mover.requests.map(
            flip =>
              `${flip.kind === 'now_kept' ? 'Now kept' : 'No longer kept'}: ${personText(flip.asker)}'s request for ${personText(flip.asked)}`
          ),
        }
      : {}),
  };
}

/**
 * Run `run` against run `other_run`: the setup changes between them, the
 * metric rows (identity rules as held counts only), and who moved — with only
 * pin and request facts, as compact texts. Without people (`withPeople`
 * false) who moved is a count: no user id, seat, pin or request of anyone.
 */
function comparisonPayload(comparison: RunComparisonView, withPeople = true) {
  const labels = comparison.rule_labels ?? {};
  return {
    run: comparison.run_number,
    other_run: comparison.other_run_number,
    grouped: comparison.grouped,
    changes: changeTexts(comparison.changes),
    metrics: comparison.metrics.map(row => ({
      key: row.key,
      ...(row.rule_id
        ? { question: labels[row.rule_id] ?? row.rule_id, identity: row.identity === true }
        : {}),
      run: row.run,
      other: row.other,
      delta: row.delta,
      ...(row.of ? { of: { run: row.of.run, other: row.of.other } } : {}),
      ...(row.same_set !== undefined ? { same_set: row.same_set } : {}),
    })),
    ...(withPeople
      ? { moved: comparison.moved.map(moverPayload) }
      : { moved_count: comparison.moved.length }),
    unchanged: comparison.unchanged,
    joined: comparison.joined,
    left: comparison.left,
  };
}

/** What one priority rule did for one person, as the why panel's sentence. */
function priorityText(fact: PriorityFact): string {
  const said = `Answered "${fact.answer}" to "${fact.question}"`;
  return fact.favored !== null && fact.other !== null
    ? `${said}: "${fact.favored}" counts ×${fact.up} and "${fact.other}" ×${fact.down} for this student.`
    : `${said}: no change to the weights.`;
}

/**
 * Why one person is where they are, from the run's own facts. Never an
 * identity answer, never any answer but their own note-rule text: the facts
 * are rebuilt key by key, so nothing else the service attaches can pass.
 * `placement` (and `rank`, `team.option`) null: not shown, the answer it would
 * be read from is on a question that is an identity question now; `placement`
 * is null for free teams too (nobody ranks anything there).
 */
function whyPayload(facts: PlacementFacts) {
  return {
    user_id: facts.user_id,
    name: facts.name,
    responded: facts.responded,
    ...(facts.non_respondents_mode ? { non_respondents_mode: facts.non_respondents_mode } : {}),
    ...(facts.grouped ? { grouped: true } : {}),
    team: {
      n: facts.team.n,
      name: facts.team.name,
      option: facts.team.option ? optionText(facts.team.option) : null,
      mates: facts.team.mates.map(personText),
    },
    placement: facts.placement,
    rank: facts.rank,
    pitched: facts.pitched.map(entry => `${optionText(entry.option)}: ${statusText(entry.status)}`),
    pins: facts.pins.map(pinPayload),
    previous: facts.previous
      ? {
          run: facts.previous.run_number,
          option: facts.previous.option ? optionText(facts.previous.option) : null,
          team: facts.previous.team_n,
        }
      : null,
    higher_picks: facts.higher_picks.map(
      pick => `${ordinal(pick.rank)} ${optionText(pick.option)}: ${statusText(pick.status)}`
    ),
    requests: facts.requests.map(request =>
      request.kept
        ? `${personText(request.user)}: kept`
        : `${personText(request.user)}: not kept (on team ${request.on.team_n}${request.on.option ? `, ${optionText(request.on.option)}` : ''})`
    ),
    notes: facts.notes.map(note => ({ field_label: note.field_label, text: note.text })),
    ...(facts.priority?.length ? { priority: facts.priority.map(priorityText) } : {}),
  };
}

/** A set named in a run response: no config (that is the setup view's). */
const setRef = (set: { id: string; name: string }) => ({ id: set.id, name: set.name });

/** How a setup places people who didn't answer: the setting (null = default) and what a run would use now. */
interface NonRespondentsView {
  setting: string | null;
  resolved: string;
}

const NON_RESPONDENT_MODES: ReadonlySet<string> = new Set(TEAM_SET_NON_RESPONDENTS);

/** The setting and the count-aware mode, closed vocabulary only; null when either is off it. */
function nonRespondentsPayload(view: NonRespondentsView | null | undefined) {
  if (!view || !NON_RESPONDENT_MODES.has(view.resolved)) return null;
  if (view.setting !== null && !NON_RESPONDENT_MODES.has(view.setting)) return null;
  return { setting: view.setting, resolved: view.resolved };
}

/**
 * A set as its SETUP: the thing a caller shows the user and patches.
 * `extras` (form_teams_get): `mustLabels`, what Must means for each rule, by
 * rule id — the page's own sentences (ruleMustLabel); `nonRespondents`, the
 * setting and the mode a run would use now (a default Group that can't seat
 * the people who didn't answer runs as Spread). The create's failures carry
 * no person here (counts only): this view is not audited.
 */
function setupPayload(
  set: TeamSetRow & { status?: TeamSetStatus; locked?: boolean },
  extras: { mustLabels?: Record<string, string>; nonRespondents?: NonRespondentsView } = {}
) {
  const { mustLabels } = extras;
  const nonRespondents = nonRespondentsPayload(extras.nonRespondents);
  return {
    id: set.id,
    name: set.name,
    ...(set.status ? { status: set.status } : {}),
    // Locked once its create is claimed: no save, run or revert after that.
    locked: set.locked === true,
    // The set's own JSON, parsed through the strict TeamSetConfigSchema on
    // every read: the thing a caller patches, so it is echoed whole — minus
    // a retired setting (the service drops those too), which does nothing.
    config: withoutRetiredKeys(set.config),
    ...(nonRespondents ? { non_respondents: nonRespondents } : {}),
    ...(mustLabels && Object.keys(mustLabels).length > 0
      ? {
          must_labels: Object.fromEntries(
            Object.entries(mustLabels).filter(([, label]) => typeof label === 'string')
          ),
        }
      : {}),
    create_status: createStatus(set),
    create_state: createStatePayload(set.create_state, false),
  };
}

function previewPayload(preview: CreatePreview) {
  return {
    run_id: preview.run_id,
    run_number: preview.run_number,
    tag: { name: preview.tag.name, exists: preview.tag.exists },
    github_teams: preview.github_teams,
    ...(typeof preview.name_template === 'string' ? { name_template: preview.name_template } : {}),
    ...(Number.isSafeInteger(preview.students) ? { students: preview.students } : {}),
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
      size: team.size ?? team.members.length,
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
    'A rule is keyed by field_id + job; strength is required only when the rule is new; params merge, and null clears one param. ' +
    'A no_one_alone rule on a multiselect counts a student toward every answer they ticked. ' +
    'Stamps (added_by, closed_by, …) are set by the server and refused in a patch.',
  params_by_job: TEAM_SET_JOB_PARAMS,
  field_types_by_job: TEAM_SET_JOB_FIELD_TYPES,
  identity:
    `A question flagged identity_question on the form takes only ${IDENTITY_QUESTION_JOBS.join(', ')}, ` +
    'strength off or prefer, without max_per_team; it can’t group teams or carry a note rule. ' +
    'Its rule is skipped when teams are pairs. Its answers are never shown per person: runs report it only as held on N of M teams.',
  priority:
    'priority (a dropdown or switch; strength off or prefer): for each student, their answer makes one rule count more and another less. ' +
    `params: rule_a, rule_b = ids "<field_id>:<job>" of two rules in this setup whose job is ${PRIORITY_TARGET_JOBS.join('/')}; ` +
    'answers = { <option id, or "true"/"false" for a switch>: "a" | "b" | "none" } (replaced whole; an answer left out is none); ' +
    `shift = 10-90 in steps of 10 (default ${DEFAULT_PRIORITY_SHIFT}). ` +
    'An "a" answer multiplies that student’s rule_a terms by 1 + shift/100 and rule_b’s by 1 − shift/100; "b" the reverse.',
  pins:
    'pins: { add: [pin without id], remove: [pin ids], clear: true }. Kinds: ' +
    '{ kind: "together", user_ids: 2-12 }, { kind: "apart", user_ids: exactly 2 }, ' +
    '{ kind: "on_option", user_id, option_id }, { kind: "not_options", user_id, option_ids }; each may carry reason. ' +
    'Ids are assigned (p1, p2, …) and never given to a second pin (the config’s last_pin_number is that counter; not patchable); adding a pin identical to an existing one is skipped.',
  options:
    'options: { <grouping option id>: { open?: auto|open|closed, size?: { min?, max? } (this option’s teams only; replaced whole), ' +
    `note?: <text shown with the option, up to ${OPTION_NOTE_MAX_CHARS} characters; blank clears>, ` +
    'category?: <a fallback option label>, team_name?: <short name for {option}> } | null }. ' +
    'null removes that option’s settings; a single field set to null clears just that field.',
  other:
    'grouping { mode: "by_option", field_id, teams_per_option } | { mode: "free" }; team_size { min, max } ' +
    '(when the count doesn’t divide, the fewest teams are one person over or under their size, automatically); ' +
    `team_count { min?, max? }; non_respondents ${TEAM_SET_NON_RESPONDENTS.join('|')} ` +
    '(people who didn’t answer: include spreads them over the teams, group seats them only with each other after everyone else is placed, exclude leaves them out; ' +
    'null = the default: group when team_size.max is 2 and they can form teams of their own, else include; ' +
    'form_teams_get’s set.non_respondents.resolved is the mode a run would use now); fairness 0-100; ' +
    'team_name_template with {set} {n} {option}; time_limit_s 5-120.',
} as const;

// ─── Shared input schemas ───────────────────────────────────────────────────

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const formIdArg = z.string().uuid().describe('Form id');
// Factories, not shared instances: the JSON Schema conversion turns a schema
// object used twice in one tool into a `$ref`, which some clients can't read.
const setRefSchema = () => z.string().min(1).max(100);
const teamSetArg = setRefSchema().describe(
  'Team set name or id; needed only when the form has several'
);
const runRefSchema = () => z.union([z.number().int().min(1), z.string().min(1).max(64)]);
const runRefArg = runRefSchema().describe('Run number (e.g. 3) or run id');

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
): Promise<TeamSetRowView | null> {
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
  compare_with?: number | string;
  person?: string;
}

/** A view of people's placements is a read of other people's submissions: audited. */
async function auditRunRead(
  ctx: ToolContext,
  form: FormRecord,
  setId: string,
  run: { id: string; number: number },
  extra: Record<string, string | number> = {},
  tool = 'form_teams_get'
): Promise<void> {
  await writeAudit(ctx, {
    resource_type: TEAM_SETS_RESOURCE,
    resource_id: run.id,
    action: 'VIEW',
    data: {
      tool,
      form_id: form.id,
      team_set_id: setId,
      run_number: run.number,
      ...extra,
    },
  });
}

/** Whether any check issue names people (user ids or names). */
const issuesNamePeople = (issues: readonly (CheckIssue & { names?: string[] })[]): boolean =>
  issues.some(
    issue =>
      !IDENTITY_CHECK_CODES.has(issue.code) &&
      ((issue.user_ids?.length ?? 0) > 0 || (issue.names?.length ?? 0) > 0)
  );

/**
 * Check issues that name people (e.g. who hasn't answered) are a read of
 * other people's submissions too: audited as a VIEW of the set (or, for a
 * set not saved yet, of the form), only when an issue names someone.
 */
async function auditIssuesRead(
  ctx: ToolContext,
  form: FormRecord,
  resourceId: string,
  issues: readonly (CheckIssue & { names?: string[] })[],
  value: string
): Promise<void> {
  if (!issuesNamePeople(issues)) return;
  await writeAudit(ctx, {
    resource_type: TEAM_SETS_RESOURCE,
    resource_id: resourceId,
    action: 'VIEW',
    data: { tool: 'form_teams_run', form_id: form.id, value },
  });
}

export const formTeamsGetTool: ToolDefinition<FormTeamsGetArgs> = {
  name: 'form_teams_get',
  title: 'Get team sets for a form',
  description:
    'Reads the team sets of a CLASSROOM form: groupings of its respondents into teams, solved ' +
    'from their answers. Staff only (owner or teacher); requires Pro.\n' +
    'Without run: the form’s sets, the chosen set’s config (its setup), lock and changes since ' +
    'its last run, a suggested config when no set exists yet, readiness, recent ' +
    'runs with summary metrics and a stale flag, and patch_help (how to write a form_teams_run patch).\n' +
    'With run: that run’s proposed teams (members with name, login, placement, requests kept, ' +
    'noted answers; per-team signals), metrics, check issues, for an infeasible run the rules that ' +
    'collide, the create progress, and next (what to do now). Identity questions show only as ' +
    'held on N of M teams, never per person.\n' +
    'With run + compare_with: setup changes, metric deltas and who moved. With run + person: ' +
    'why that student is where they are.\n' +
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
    compare_with: runRefSchema().optional().describe('With run: the run to compare it with'),
    person: z.string().uuid().optional().describe('With run: a student’s user id'),
  },
  handler: async (args, ctx) => {
    await assertProTier(ctx);
    const { classroomId } = requireClassroomCtx(ctx);
    // Argument shapes cost no query.
    if ((args.compare_with !== undefined || args.person !== undefined) && args.run === undefined) {
      throw new ToolError('invalid_params', 'compare_with and person need run', 'invalid_args');
    }
    if (args.compare_with !== undefined && args.person !== undefined) {
      throw new ToolError(
        'invalid_params',
        'Pass compare_with or person, not both',
        'invalid_args'
      );
    }
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

      // ── run + person: the facts behind one placement ──
      if (args.person !== undefined) {
        const userId = args.person;
        if (run.status !== 'SOLVED') {
          throw new ToolError(
            'invalid_params',
            `Run ${run.number} is ${run.status}; only a SOLVED run has placements`,
            'run_not_solved',
            { status: run.status }
          );
        }
        const [facts] = await withTeamSetRules(
          () =>
            service.explainPlacements({
              classroomId,
              teamSetId: set.id,
              runRef: run.id,
              userIds: [userId],
            }),
          'Run'
        );
        if (!facts || facts.user_id !== userId) {
          throw new ToolError(
            'invalid_params',
            'That person is not in this run',
            'person_not_in_run'
          );
        }
        await auditRunRead(ctx, form, set.id, run, { value: `person:${userId}` });
        return ok({
          team_set: setRef(set),
          run: { number: run.number, status: run.status },
          why: whyPayload(facts),
        });
      }

      const includePeople = args.include_people ?? true;

      // ── run + compare_with ──
      if (args.compare_with !== undefined) {
        const otherRunRef = args.compare_with;
        const comparison = await withTeamSetRules(
          () =>
            service
              .compareRuns({
                classroomId,
                teamSetId: set.id,
                runRef: run.id,
                otherRunRef,
                includePeople,
              })
              .catch(compareRefusal),
          'Run'
        );
        // With people, movers and pin changes carry names; without, the
        // payload carries no person at all (comparisonPayload).
        if (includePeople) {
          await auditRunRead(ctx, form, set.id, run, {
            value: `compare:${comparison.other_run_number}`,
          });
        }
        return ok({
          team_set: setRef(set),
          run: { number: run.number, status: run.status },
          comparison: comparisonPayload(comparison, includePeople),
        });
      }

      // Never `revealIdentity`: which teams an identity rule missed is the
      // page's explicit, audited reveal, not an agent's read.
      const view = await withTeamSetRules(() =>
        service.describeRun({ classroomId, run, includePeople })
      );

      if (includePeople) {
        // Members' names and quoted answers are other people's submissions —
        // the reason forms.ts audits its response reads as VIEW rows. A run
        // without teams names people too (a Can't-solve item's students, a
        // check's names, a pin in the changes), so it is audited as well.
        // Without people the payload names no one (runViewPayload).
        await auditRunRead(ctx, form, set.id, run);
      }

      return ok({
        team_set: setRef(set),
        run: runViewPayload(view, createContext(set, run.id), includePeople),
        created_from_this_run: set.created_run_id === run.id,
        create_status: createStatus(set),
        create_state: createStatePayload(set.create_state, includePeople),
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

    // Two counts: the roster, and how many of it answered (no answer is read).
    const readiness = await withTeamSetRules(() =>
      service.readinessCounts({ classroomId, formId: form.id })
    );
    // What Must means for each of the set's rules, as the page words it.
    const mustLabels = set
      ? await withTeamSetRules(() =>
          service.mustLabels({ classroomId, formId: form.id, config: set.config })
        )
      : undefined;
    // How people who didn't answer are placed: the setting, and the mode a
    // run would use now (count-aware, as the page shows it).
    const nonRespondents = set
      ? await withTeamSetRules(() => service.nonRespondentsFor({ classroomId, teamSetId: set.id }))
      : undefined;

    const summary = set ? summaries.find(entry => entry.id === set.id) : undefined;
    const runs = set ? await recentRuns(classroomId, set.id) : [];
    // The setup against its latest run's, with the mode a run would use now.
    // Name-free: this view is not audited.
    const changes =
      set && runs.length > 0
        ? await withTeamSetRules(() =>
            service.changesSinceRun({
              classroomId,
              teamSetId: set.id,
              ...(nonRespondents ? { nonRespondents: nonRespondents.resolved } : {}),
            })
          )
        : null;

    return ok({
      team_sets: summaries.map(entry => ({
        id: entry.id,
        name: entry.name,
        ...(entry.status ? { status: entry.status } : {}),
        create_status: createStatus(entry),
        run_count: entry.run_count,
        latest_run: entry.latest_run
          ? { number: entry.latest_run.number, status: entry.latest_run.status }
          : null,
      })),
      set: set
        ? setupPayload(set, {
            ...(mustLabels ? { mustLabels } : {}),
            ...(nonRespondents ? { nonRespondents } : {}),
          })
        : null,
      ...(changes && changes.run_number !== null
        ? {
            changes_since_last_run: {
              run: changes.run_number,
              changes: changeTexts(changes.changes, true),
            },
          }
        : {}),
      ...(ambiguous
        ? { hint: 'This form has several team sets; pass team_set to choose one' }
        : {}),
      ...(suggested
        ? {
            suggested_config: suggested.config,
            suggested_name: suggested.name,
            next: 'Show the suggested setup to the user in plain words. form_teams_run saves it (without running); run it with start: true once they agree.',
          }
        : set?.locked
          ? {
              next: 'This set is locked: its teams were created (or are being created), so its setup can’t change. To group differently, start a new set from it (form_teams_run with copy_from and new_set: true).',
            }
          : {}),
      readiness: {
        roster: readiness.roster,
        responded: readiness.responded,
        not_responded: readiness.roster - readiness.responded,
      },
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
  copy_from?: string;
  revert_to_run?: number | string;
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
  if (parsed.success) {
    // Classroom-only teams are not made yet (the page shows the choice fixed
    // on); a set saved with them could never be created.
    if (parsed.data.github_teams === false) {
      throw new ToolError(
        'invalid_params',
        'github_teams: false is not supported yet; every create makes GitHub teams',
        'github_teams_off_unsupported'
      );
    }
    return parsed.data;
  }
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

/**
 * Refuse argument combinations that mean two different acts, before anything
 * is read. `copy_from` makes a new set (so it needs new_set and takes no
 * patch: the copy is patched on the next call); `revert_to_run` puts an
 * existing set's setup back (Discard) and saves only.
 */
function assertRunArgs(args: FormTeamsRunArgs): void {
  const refuse = (message: string): never => {
    throw new ToolError('invalid_params', message, 'invalid_args');
  };
  if (args.copy_from !== undefined) {
    if (!args.new_set) refuse('copy_from needs new_set: true');
    if (args.patch !== undefined || args.check) {
      refuse('copy_from copies the setup as it is; patch or check the new set on the next call');
    }
  }
  if (args.revert_to_run !== undefined) {
    if (args.new_set || args.copy_from !== undefined || args.name !== undefined) {
      refuse('revert_to_run applies to an existing set (team_set); it makes no new set');
    }
    if (args.patch !== undefined || args.check) {
      refuse('revert_to_run takes no patch or check; patch the reverted setup on the next call');
    }
    if (args.start === true) {
      refuse('revert_to_run saves only; run the reverted setup on the next call (start: true)');
    }
  }
}

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
    'options (open, size, note), team_size, grouping, non_respondents (include/group/exclude). ' +
    'Jobs: rank, fallback, owner, together/apart (roster_select), match/mix, balance, ' +
    'no_one_alone, note, priority.\n' +
    'The call that creates a set (the form’s first; name + new_set: true for another; copy_from ' +
    '+ new_set: true to copy a set’s setup) only saves it and never runs: show the user the ' +
    'setup in plain words, then call again with start: true after they agree.\n' +
    'revert_to_run puts the setup back to that run’s and saves only. check: true saves and starts ' +
    'nothing; it returns the would-be config and its issues. A run is a proposal and never ' +
    'creates teams (form_teams_create does); once a set’s teams exist it is locked. If the call ' +
    'times out or returns a run number, poll with form_teams_get; don’t start another run.',
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
      .describe('With name or copy_from: make ANOTHER set on a form that already has one'),
    copy_from: setRefSchema().optional().describe('With new_set: the set to copy'),
    revert_to_run: runRefSchema().optional().describe('Restore this run’s setup (Discard)'),
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
    // A malformed patch or a contradictory call costs no query: refused
    // before the form is read.
    const patch = args.patch !== undefined ? parsePatch(args.patch) : undefined;
    if (
      args.new_set &&
      ((args.name === undefined && args.copy_from === undefined) || args.team_set !== undefined)
    ) {
      throw new ToolError(
        'invalid_params',
        'new_set needs name (the new set’s name) or copy_from, and no team_set',
        'invalid_config'
      );
    }
    assertRunArgs(args);
    const form = await loadPublishedForm(args.form_id, ctx);
    const service = teamSets();
    const userId = ctx.viewer.userId;

    // ── copy_from: a new set with another set's setup; never runs ──
    if (args.copy_from !== undefined) {
      if (args.name !== undefined) {
        const clash = await resolveSet(classroomId, form.id, args.name);
        if (clash) throw nameTakenError(clash.name);
      }
      const source = await resolveSet(classroomId, form.id, args.copy_from);
      if (!source) throw scopedNotFound('Team set');
      const created = await withTeamSetRules(() =>
        service.newSetFromSetup({
          classroomId,
          formId: form.id,
          fromSetRef: source.id,
          ...(args.name !== undefined ? { name: args.name } : {}),
          userId,
          via: 'mcp',
        })
      );
      await writeAudit(ctx, {
        resource_type: TEAM_SETS_RESOURCE,
        resource_id: created.id,
        action: 'CREATE',
        data: {
          tool: 'form_teams_run',
          form_id: form.id,
          name: created.name,
          copied_from: source.id,
          patched: [],
          value: `copy:${source.id}`,
        },
      });
      return ok({
        team_set: setupPayload(created),
        set_created: true,
        copied_from: setRef(source),
        started: false,
        ...(args.start === true
          ? { start_refused: 'A new set is never run on the call that creates it.' }
          : {}),
        next: FIRST_RUN_NEXT,
      });
    }

    // ── revert_to_run: Discard — the setup a run was solved with; saves only ──
    if (args.revert_to_run !== undefined) {
      const runRef = args.revert_to_run;
      const target = await resolveSet(classroomId, form.id, args.team_set);
      if (!target) throw scopedNotFound('Team set');
      const reverted = await withTeamSetRules(
        () =>
          service.revertToRun({ classroomId, teamSetId: target.id, runRef, userId, via: 'mcp' }),
        'Run'
      );
      await writeAudit(ctx, {
        resource_type: TEAM_SETS_RESOURCE,
        resource_id: reverted.id,
        action: 'UPDATE',
        data: {
          tool: 'form_teams_run',
          form_id: form.id,
          name: reverted.name,
          reverted_to_run: runRef,
          patched: [],
          value: `revert:${runRef}`,
        },
      });
      // What the restore left out (parts of that run's setup that no longer fit).
      const revertNotes = strings(reverted.notes) ?? [];
      return ok({
        team_set: setupPayload(reverted),
        set_created: false,
        reverted_to_run: runRef,
        started: false,
        ...(revertNotes.length ? { notes: revertNotes } : {}),
        next: revertNotes.length
          ? 'The setup is back to that run’s, except what notes lists. Show the user what it is now; call again with start: true to run it.'
          : 'The setup is back to that run’s. Show the user what it is now; call again with start: true to run it.',
      });
    }

    // Which set this call is about — resolved the way saveConfig picks it: the
    // reference, else the name, else the form's only set.
    const existing = await resolveSet(classroomId, form.id, args.team_set ?? args.name);
    if (args.team_set !== undefined && !existing) throw scopedNotFound('Team set');
    if (existing && args.new_set) throw nameTakenError(existing.name);
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
      await auditIssuesRead(
        ctx,
        form,
        existing?.id ?? form.id,
        checked.issues,
        `check:${patchFingerprint(patch)}`
      );
      // A locked set takes no save: the check still answers, and says so.
      const locked = existing?.locked === true;
      const checkedMode = nonRespondentsPayload(checked.non_respondents);
      return ok({
        checked: true,
        saved: false,
        started: false,
        team_set: existing ? setRef(existing) : null,
        ...(locked ? { locked: true } : {}),
        name: checked.name,
        config: withoutRetiredKeys(checked.config),
        ...(checkedMode ? { non_respondents: checkedMode } : {}),
        ...(checked.notes.length ? { notes: checked.notes } : {}),
        issues: checked.issues.map(issue => issuePayload(issue)),
        next: locked
          ? 'This set is locked: its teams were created (or are being created), so this patch can’t be saved or run. To group differently, start a new set from it (form_teams_run with copy_from and new_set: true).'
          : blocking
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
        via: 'mcp',
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
      await auditIssuesRead(ctx, form, saved.id, issues, `checks:${patchFingerprint(patch)}`);
      return ok({
        team_set: setRef(saved),
        started: false,
        ...(notes.length ? { notes } : {}),
        issues: issues.map(issue => issuePayload(issue)),
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
      await auditIssuesRead(ctx, form, latest.id, issues, `checks:${patchFingerprint(patch)}`);
      return ok({
        team_set: setRef(saved),
        started: true,
        run: { number: latest.number, status: latest.status },
        ...(notes.length ? { notes } : {}),
        next: nextForRun(latest),
        ...(issues.length ? { issues: issues.map(issue => issuePayload(issue)) } : {}),
      });
    }

    const view = await withTeamSetRules(() =>
      service.describeRun({ classroomId, run: latest, includePeople: true })
    );
    // The finished run's teams name their members: a read of people, audited
    // as form_teams_get audits it.
    await auditRunRead(ctx, form, saved.id, latest, {}, 'form_teams_run');
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
      // The preview names every member of every team: audited like a run read.
      await writeAudit(ctx, {
        resource_type: TEAM_SETS_RESOURCE,
        resource_id: preview.run_id,
        action: 'VIEW',
        data: {
          tool: 'form_teams_create',
          form_id: form.id,
          team_set_id: set.id,
          run_number: preview.run_number,
          value: 'preview',
        },
      });
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
