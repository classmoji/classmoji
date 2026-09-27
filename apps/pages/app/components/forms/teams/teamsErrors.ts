/**
 * Team sets page — every refusal and failure code, as one fixed sentence.
 *
 * The service's `TeamSetError.message` is written for agents and carries fix
 * suggestions ("Change team_name_template … and run again"), so the page never
 * shows it: the action and the components look the code up here instead. Each
 * sentence states what happened or what is so, filled only with facts the
 * error's `details` carry (a run number, a tag name); lists the details hold
 * (taken names, what changed since a run) come back as `items`, never as prose.
 *
 * Pure, and safe on both sides: the set layout's action maps a caught error to
 * `{ error, errorCode, errorItems }` before returning it, and the components
 * map run and create codes they find in loader data.
 *
 * Vocabularies (closed; each has a compile-time check that the service's union
 * is covered, so a code the service adds without a sentence here fails the
 * pages typecheck):
 *   TEAM_SET_ERROR_CODES   TeamSetError.code (the page's own name_taken and
 *                          github_teams_off_unsupported refusals, returned
 *                          before the service is asked, use the service's
 *                          codes and sentences too)
 *   PAGE_ERROR_CODES       what only the page's own gates return
 *   RUN_ERROR_CODES        team_set_runs.error
 *   CREATE_FAILURE_REASONS create_state failures, per team
 *   MEMBER_FAILURE_REASONS create_state failures, per member
 *   tag_required           teamAdmin (a team's tags)
 */

import type {
  CreateFailureReason,
  CreateMemberFailureReason,
  TeamSetErrorCode,
  TeamSetRunErrorCode,
} from '@classmoji/services';

type Details = Record<string, unknown>;
type Sentence = string | ((details: Details) => string);

const asDetails = (details: unknown): Details =>
  details !== null && typeof details === 'object' ? (details as Details) : {};

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// ─── Team set refusals (TeamSetError.code) ──────────────────────────────────

export const TEAM_SET_ERROR_CODES = [
  'not_found',
  'invalid_config',
  'no_grouping_field',
  'form_not_classroom',
  'checks_failed',
  'run_not_solved',
  'run_stale',
  'already_created',
  'create_in_progress',
  'tag_conflict',
  'trigger_unavailable',
  'github_unavailable',
  'name_collision',
  'provider_unsupported',
  'set_locked',
  'run_in_progress',
  /** A new set named like one the form already has; details `{ name }`. */
  'name_taken',
  /** Classroom-only teams (github_teams false): refused at create and in a patch. */
  'github_teams_off_unsupported',
  /** A save found the set held by a run or another save, and wrote nothing. */
  'set_busy',
] as const;
export type TeamSetPageErrorCode = (typeof TEAM_SET_ERROR_CODES)[number];

const TEAM_SET_SENTENCES: Record<TeamSetPageErrorCode, Sentence> = {
  not_found: "That team set or run isn't on this form.",
  invalid_config: "That setting isn't valid for this set.",
  no_grouping_field:
    "The question the teams are made from isn't a ranked-choice or dropdown question on the current form.",
  form_not_classroom: 'Team sets need a classroom form.',
  checks_failed: "The run didn't start: the checks found errors.",
  run_not_solved: details => {
    const run = positiveInt(details.run_number);
    return run !== null ? `Run ${run} has no teams.` : "This run isn't solved.";
  },
  run_stale: 'Answers or the roster changed since this run.',
  already_created: details => {
    const run = positiveInt(details.run_number);
    return details.status === 'FAILED' && run !== null
      ? `Teams were partly created from run ${run}; only that run can be retried.`
      : 'Teams were already created from this set.';
  },
  create_in_progress: 'Teams for this set are being created now.',
  tag_conflict: details => {
    const tag = text(details.tag);
    return tag ? `The tag "${tag}" already has teams.` : "The set's tag already has teams.";
  },
  trigger_unavailable: "This didn't start. Nothing was created.",
  github_unavailable: details =>
    details.reason === 'timeout'
      ? "GitHub didn't answer."
      : "The classroom's GitHub organization can't be reached.",
  name_collision: details => {
    const count = strings(details.names).length;
    if (count === 1) return 'This team name is already used in the GitHub organization:';
    if (count > 1) return 'These team names are already used in the GitHub organization:';
    return 'A team name is already used in the GitHub organization.';
  },
  provider_unsupported:
    "Creating teams needs a GitHub organization; this classroom's isn't on GitHub.",
  set_locked: "This set's teams exist, so its setup can't change.",
  run_in_progress: details => {
    const run = positiveInt(details.run_number);
    return run !== null ? `Run ${run} hasn't finished.` : "A run hasn't finished.";
  },
  name_taken: details => {
    const name = text(details.name);
    return name
      ? `A team set named "${name}" is already on this form.`
      : 'A team set with that name is already on this form.';
  },
  github_teams_off_unsupported: "Creating teams without GitHub teams isn't available.",
  // details `{ action: 'run' }` when a run was being started, not a change saved.
  set_busy: details =>
    details.action === 'run'
      ? 'No run was started. The set was busy.'
      : "This change wasn't saved. The set was busy.",
};

/**
 * Codes whose `details` carry a list the page shows under the sentence. An
 * `invalid_config` save lists the service's config problems (facts about the
 * setup and the form: which rule, which question, which pin), so a refused
 * save says what was refused.
 */
const TEAM_SET_ITEMS: Partial<Record<TeamSetPageErrorCode, (details: Details) => string[]>> = {
  invalid_config: details => strings(details.problems),
  name_collision: details => strings(details.names),
  run_stale: details => strings(details.reasons),
};

// ─── The page's own refusals ────────────────────────────────────────────────

export const PAGE_ERROR_CODES = [
  'owner_only',
  'tag_required',
  'set_name_empty',
  'unknown',
] as const;
export type PageErrorCode = (typeof PAGE_ERROR_CODES)[number];

const PAGE_SENTENCES: Record<PageErrorCode, Sentence> = {
  /** The create family (preview, create, retry) for a teacher. */
  owner_only: 'Only classroom owners can create teams.',
  /** teamAdmin's TeamServiceError('tag_required'): on create and on removing a last tag. */
  tag_required: 'Every team needs at least one tag.',
  /** A typed set name with nothing left once it is made a set name ("!!!"). */
  set_name_empty: 'A team set name needs at least one letter or digit.',
  /** Anything without a code of its own. */
  unknown: 'The request failed.',
};

export type TeamsErrorCode = TeamSetPageErrorCode | PageErrorCode;

/** What the page shows for a refusal: one sentence, and the list it names (may be empty). */
export interface TeamsErrorView {
  code: TeamsErrorCode;
  message: string;
  items: string[];
}

const isTeamSetCode = (code: string): code is TeamSetPageErrorCode =>
  (TEAM_SET_ERROR_CODES as readonly string[]).includes(code);

const isPageCode = (code: string): code is PageErrorCode =>
  (PAGE_ERROR_CODES as readonly string[]).includes(code);

const fill = (sentence: Sentence, details: Details): string =>
  typeof sentence === 'string' ? sentence : sentence(details);

/** The sentence and list for a refusal code; an unrecognized code gets the `unknown` sentence. */
export function teamsErrorView(code: string, details?: unknown): TeamsErrorView {
  const facts = asDetails(details);
  if (isTeamSetCode(code)) {
    return {
      code,
      message: fill(TEAM_SET_SENTENCES[code], facts),
      items: TEAM_SET_ITEMS[code]?.(facts) ?? [],
    };
  }
  if (isPageCode(code)) return { code, message: fill(PAGE_SENTENCES[code], facts), items: [] };
  return { code: 'unknown', message: fill(PAGE_SENTENCES.unknown, facts), items: [] };
}

/** Just the sentence (see teamsErrorView). */
export function teamsErrorSentence(code: string, details?: unknown): string {
  return teamsErrorView(code, details).message;
}

/**
 * A caught error's view, when it is one of the services' coded refusals
 * (TeamSetError, TeamServiceError — matched by name, so this file never loads
 * the service). null for anything else, which the caller rethrows or logs.
 */
export function teamsErrorFrom(error: unknown): TeamsErrorView | null {
  if (!(error instanceof Error)) return null;
  if (error.name !== 'TeamSetError' && error.name !== 'TeamServiceError') return null;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  if (typeof code !== 'string') return null;
  return teamsErrorView(code, details);
}

// ─── Run errors (team_set_runs.error) ───────────────────────────────────────

export const RUN_ERROR_CODES = [
  'trigger_unavailable',
  'engine_error',
  'score_mismatch',
  'no_solution_in_time',
  'model_invalid',
  'canceled',
  'lost',
  'queue_expired',
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

const RUN_SENTENCES: Record<RunErrorCode, string> = {
  trigger_unavailable: "The run didn't start.",
  engine_error: 'The solver stopped with an error.',
  score_mismatch: "The solver's result was rejected. No teams were kept.",
  no_solution_in_time: 'The solver stopped without finding teams.',
  model_invalid: 'The solver refused this setup as invalid.',
  canceled: 'The run was canceled.',
  lost: 'The run stopped without finishing.',
  queue_expired: 'The run never started.',
};

const RUN_FAILED_SENTENCE = 'The run failed.';

/**
 * The line a FAILED or CANCELED run shows. `error` null on a CANCELED run
 * reads as canceled; any other unknown value reads as a plain failure.
 */
export function runErrorSentence(error: string | null, status?: 'FAILED' | 'CANCELED'): string {
  if (error !== null && (RUN_ERROR_CODES as readonly string[]).includes(error)) {
    return RUN_SENTENCES[error as RunErrorCode];
  }
  return status === 'CANCELED' ? RUN_SENTENCES.canceled : RUN_FAILED_SENTENCE;
}

// ─── Create failures (create_state.failed) ──────────────────────────────────

export const CREATE_FAILURE_REASONS = [
  'classroom_not_found',
  'no_org_configured',
  'provider_unsupported',
  'team_not_found',
  'invalid_name',
  'reserved_name',
  'name_collision',
  'tag_not_found',
  'tag_required',
  'user_not_found',
  'provider_error',
  'db_error',
  'tag_failed',
  'members_failed',
  'internal_error',
  'lost',
  'canceled',
] as const;
export type CreateFailureCode = (typeof CREATE_FAILURE_REASONS)[number];

const CREATE_FAILURE_SENTENCES: Record<CreateFailureCode, string> = {
  classroom_not_found: "The classroom wasn't found.",
  no_org_configured: 'The classroom has no GitHub organization.',
  provider_unsupported: "The classroom's organization isn't on GitHub.",
  team_not_found: "The team wasn't found.",
  invalid_name: "The team name isn't valid.",
  reserved_name: 'The team name is reserved.',
  name_collision: 'The team name is already taken.',
  tag_not_found: "The set's tag wasn't found.",
  tag_required: 'The team had no tag.',
  user_not_found: "A member's account wasn't found.",
  provider_error: 'GitHub returned an error.',
  db_error: "The team wasn't saved.",
  tag_failed: "The team's tag wasn't added.",
  members_failed: "Some members weren't added.",
  internal_error: "The team wasn't made.",
  lost: 'The create stopped without finishing.',
  canceled: 'The create was canceled.',
};

/** The line for a team (or, with team '*', the whole create) that failed. */
export function createFailureSentence(reason: string | null | undefined): string {
  return reason && (CREATE_FAILURE_REASONS as readonly string[]).includes(reason)
    ? CREATE_FAILURE_SENTENCES[reason as CreateFailureCode]
    : CREATE_FAILURE_SENTENCES.internal_error;
}

export const MEMBER_FAILURE_REASONS = [
  'no_login',
  'no_local_user',
  'github_user_not_found',
  'provider_error',
  'db_error',
] as const;
export type MemberFailureCode = (typeof MEMBER_FAILURE_REASONS)[number];

const MEMBER_FAILURE_SENTENCES: Record<MemberFailureCode, string> = {
  no_login: 'The account has no GitHub login.',
  no_local_user: "The GitHub login doesn't match a Classmoji account.",
  github_user_not_found: 'GitHub has no user with that login.',
  provider_error: 'GitHub returned an error.',
  db_error: "The membership wasn't saved.",
};

const MEMBER_FAILED_SENTENCE = "The member wasn't added.";

/** The line for one person who could not be added to their team. */
export function memberFailureSentence(reason: string | null | undefined): string {
  return reason && (MEMBER_FAILURE_REASONS as readonly string[]).includes(reason)
    ? MEMBER_FAILURE_SENTENCES[reason as MemberFailureCode]
    : MEMBER_FAILED_SENTENCE;
}

// ─── Every sentence, for the unit spec's word scan ──────────────────────────

/** Every fixed sentence in this file, templated ones filled with sample details. */
export function allErrorSentences(): string[] {
  const samples: Details[] = [
    {},
    { run_number: 6, status: 'FAILED', tag: 'project-teams', reason: 'timeout', name: 'pairs' },
    { names: ['project-teams-studio'] },
    { names: ['project-teams-studio', 'project-teams-pantry'] },
    { action: 'run' },
  ];
  const sentences = new Set<string>();
  for (const code of [...TEAM_SET_ERROR_CODES, ...PAGE_ERROR_CODES]) {
    for (const details of samples) sentences.add(teamsErrorSentence(code, details));
  }
  for (const code of RUN_ERROR_CODES) sentences.add(RUN_SENTENCES[code]);
  sentences.add(RUN_FAILED_SENTENCE);
  for (const code of CREATE_FAILURE_REASONS) sentences.add(CREATE_FAILURE_SENTENCES[code]);
  for (const code of MEMBER_FAILURE_REASONS) sentences.add(MEMBER_FAILURE_SENTENCES[code]);
  sentences.add(MEMBER_FAILED_SENTENCE);
  return [...sentences];
}

// ─── Compile-time coverage of the services' vocabularies ────────────────────
// Each assignment fails to typecheck when the service's union gains a code
// that has no sentence here. Extra codes are allowed.

type CoversAll<Codes extends string> = Readonly<Record<Codes, unknown>>;

export const TEAM_SET_CODES_COVERED: CoversAll<TeamSetErrorCode> = TEAM_SET_SENTENCES;
export const RUN_CODES_COVERED: CoversAll<TeamSetRunErrorCode> = RUN_SENTENCES;
export const CREATE_FAILURES_COVERED: CoversAll<CreateFailureReason> = CREATE_FAILURE_SENTENCES;
export const MEMBER_FAILURES_COVERED: CoversAll<CreateMemberFailureReason> =
  MEMBER_FAILURE_SENTENCES;
