/**
 * Team sets — what a setup and a run mean to the person reading them.
 *
 * PURE MODULE (the other pure team-set modules and the forms contract, and
 * nothing else), so the page can import it in the browser. The Teams page and
 * the MCP tools show the same facts from the same functions here: set status,
 * Must labels, Can't-solve items (labelSrc / coreItems), why a person is where
 * they are (placementFacts), a team card's signals (teamSignals), what changed
 * between two setups (diffConfigs), what moved between two runs
 * (compareAssignments), since when an option has been closed
 * (closedProvenance), and the sentence an unsolved run carries
 * (infeasibleSummary).
 *
 * Every string produced here is a fixed template filled with facts: counts,
 * labels, names resolved at read time, text a person typed. No causes, no
 * advice, no timing. Advice for agents lives in the MCP tools' hints. Option
 * labels are quoted with single quotes ('Pulse' is closed), question labels
 * and typed text with double quotes.
 *
 * Inputs are plain snapshots (`ExplainRun`: a run's config, problem, context,
 * result and metrics), never service rows, so nothing here reads a database.
 * Names never enter a run's stored JSON; the shapes below carry them because
 * the service passes them in (`ExplainLabels.names`) when it reads. Without
 * names, a text that would name a person counts instead ("one student →
 * 'Studio'") and PersonRefs carry null names. Identity-question answers never
 * appear in any per-person shape.
 */

import { isIdentityQuestion, type FormField } from './formContract.ts';
import {
  DEFAULT_PRIORITY_SHIFT,
  fieldOptions,
  fieldRanks,
  optionSize,
  priorityShift,
  resolveNonRespondents,
  TEAM_SET_JOB_WORDS,
  teamSetRuleId,
  type TeamSetConfig,
  type TeamSetJob,
  type TeamSetNonRespondents,
  type TeamSetPin,
  type TeamSetRule,
  type TeamSetRuleParams,
} from './teamSetConfig.ts';
import type {
  TeamSetMetrics,
  TeamSetNonRespondentMetrics,
  TeamSetPlacement,
} from './teamSetMetrics.ts';
import {
  FREE_OPTION_ID,
  parseSrc,
  type ParsedSrc,
  type TeamSetContext,
  type TeamSetProblem,
  type TeamSetSolveStages,
} from './teamSetProblem.ts';

// ─── Shared references ──────────────────────────────────────────────────────

/** Where a change was saved from: the Teams page or an MCP tool. */
export type TeamSetVia = 'page' | 'mcp';

/** A person as a view shows them; `name` is null when the account has none. */
export interface PersonRef {
  user_id: string;
  name: string | null;
}

/** An option of the grouping question; `label` is null when it is no longer on the form. */
export interface OptionRef {
  id: string;
  label: string | null;
}

/** How people who didn't answer are placed ('include' is shown as "Spread them out"). */
export type NonRespondentsMode = TeamSetNonRespondentMetrics['mode'];

// ─── Set status ─────────────────────────────────────────────────────────────

/**
 * Where a set is, read from its create columns:
 *   setting_up     no create claimed
 *   creating       a create is claimed and not finished
 *   created        DONE: every team and every member made it
 *   partial        PARTIAL: every team exists; some members or tags were not added
 *   create_failed  FAILED: at least one team was not made
 *
 * A set is LOCKED (saves, runs and Discard refused with `set_locked`) once a
 * create is claimed, except after a FAILED create that made no team:
 *   locked ⇔ created_run_id !== null
 *            && !(create_state.status === 'FAILED' && create_state.teams.length === 0)
 */
export type TeamSetStatus = 'setting_up' | 'creating' | 'created' | 'partial' | 'create_failed';

/** `team_sets.create_state.status`. */
export type TeamSetCreateStatus = 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED';

/**
 * The status of a set row. A claim with no state written yet counts as
 * creating, as the create path itself treats it. A RUNNING create whose task
 * died reads as creating until the service expires it (expireLostCreate), so
 * pass a row the service has already read through that.
 */
export function setStatus(set: {
  created_run_id: string | null;
  create_state: { status: TeamSetCreateStatus } | null;
}): TeamSetStatus {
  if (set.created_run_id === null) return 'setting_up';
  switch (set.create_state?.status) {
    case 'DONE':
      return 'created';
    case 'PARTIAL':
      return 'partial';
    case 'FAILED':
      return 'create_failed';
    default:
      return 'creating';
  }
}

// ─── Must labels ────────────────────────────────────────────────────────────

/**
 * The sentence that says what Must means for this rule, as the engine
 * enforces it — the one template shared by the page and the MCP tools. null
 * when the rule can't be Must: balance, note, priority, numeric mix, and any
 * identity question. Depends on the job, its params and the question's type,
 * never on the rule's current strength.
 */
export function ruleMustLabel(
  rule: Pick<TeamSetRule, 'job' | 'params'>,
  field: FormField
): string | null {
  // Identity questions take Off or Prefer only.
  if (isIdentityQuestion(field)) return null;
  const job: TeamSetJob = rule.job;
  switch (job) {
    case 'rank': {
      if (field.type === 'dropdown') return 'Everyone gets the option they picked';
      const top = rule.params.must_top;
      if (top === 1 || fieldRanks(field) === 1) return 'Everyone gets their first pick';
      if (top !== undefined) return `Everyone gets one of their top ${top}`;
      return 'Everyone gets one of the options they ranked';
    }
    case 'fallback':
      return 'Everyone gets an option they ranked or one in a category they chose';
    case 'owner':
      // An option that opens has at least one of the people who pitched it.
      return 'A project runs only with one of its pitchers on it';
    case 'together':
      return rule.params.mutual_only === false
        ? 'Every requested pair always together'
        : 'Mutual requests always together';
    case 'apart':
      return 'Never on the same team';
    case 'match':
      return field.type === 'multiselect'
        ? 'Teammates always share an answer'
        : 'Teammates always gave the same answer';
    case 'mix':
      if (field.type === 'opinion_scale' || field.type === 'number') return null;
      return 'No two teammates gave the same answer';
    case 'no_one_alone': {
      const max = rule.params.max_per_team;
      const who = field.type === 'switch' ? 'who said yes' : 'with the same answer';
      if (max !== undefined)
        return `At most ${max} ${max === 1 ? 'person' : 'people'} ${who} on a team`;
      return field.type === 'switch'
        ? 'No one who said yes is the only one on their team'
        : 'No one is the only person on their team with their answer';
    }
    case 'balance':
    case 'note':
      return null;
    default:
      return null; // jobs without a Must (priority)
  }
}

// ─── Options ────────────────────────────────────────────────────────────────

/**
 * An option as a run left it (higher picks, pitched options, Can't solve):
 *   closed       set to Closed
 *   not_running  it could run, but no team was opened on it
 *   full         teams were opened and every seat is taken (placed ≥ max)
 *   running      teams were opened with seats left
 *   not_on_form  no longer an option of the grouping question
 * placed = people on it; max = its seats (its team slots × its max team size,
 * plus one for each of its teams one over its size — the remainder flex —
 * as teamSignals counts a team's seats).
 */
export type OptionRunState = 'closed' | 'not_running' | 'full' | 'running' | 'not_on_form';

export interface OptionStatus {
  status: OptionRunState;
  placed: number;
  max: number;
}

/**
 * Since when an option has been closed, from the run config snapshots:
 * `since_run` = the first run of the unbroken streak of runs that had it
 * closed (null = closed after the last run); `by`/`via` = the save stamp,
 * else that run's starter. `by` is a user id here.
 */
export interface ClosedProvenance {
  since_run: number | null;
  by: string | null;
  via: TeamSetVia | null;
}

/** ClosedProvenance with the person resolved at read time. */
export interface ClosedProvenanceView {
  since_run: number | null;
  by: PersonRef | null;
  via: TeamSetVia | null;
}

// ─── Pins ───────────────────────────────────────────────────────────────────

/** A pin with names and labels resolved. */
export interface PinView {
  id: string;
  kind: TeamSetPin['kind'];
  /** Everyone the pin names, in the pin's order. */
  people: PersonRef[];
  /** on_option: the option; null for every other kind. */
  option: OptionRef | null;
  /** not_options: the options. */
  options?: OptionRef[];
  reason: string | null;
  /** Stamped when the pin was saved; null on pins saved before stamps existed. */
  added_by: PersonRef | null;
  added_via: TeamSetVia | null;
  /** ISO time. */
  added_at: string | null;
}

// ─── Can't solve ────────────────────────────────────────────────────────────

/** The Setup section a Can't-solve item links to. */
export type TeamSetSetupTab = 'questions' | 'projects' | 'pins' | 'team_shape' | 'non_respondents';

/** One entry of an INFEASIBLE run's conflict list. */
export interface CoreItem {
  src: string;
  kind: ParsedSrc['kind'];
  /**
   * Facts template. For a per-student src (`<rule>@p`, `<rule>@p+q`) the rule
   * part only ("Rank the projects (rank, must)"): the page names the
   * student(s) from `people`. Every other kind is the whole sentence (a pin's
   * names are in it only when the view includes people).
   */
  label: string;
  /** The people a per-person or per-pair src, or a pin, names. */
  user_ids?: string[];
  /**
   * Per-student srcs only: the student(s), in `user_ids` order; `name` is
   * null when the view doesn't include people or the account has none.
   */
  people?: PersonRef[];
  /**
   * Pair srcs only (`<rule>@p+q`, together/apart at Must): who is paired
   * with whom, as positions in `people`, in the engine's order — [[0, 1],
   * [2, 3]] reads "A with B, C with D". Positions only, so an item stripped
   * of its people carries no one.
   */
  pairs?: [number, number][];
  /** option and size srcs: the option as that run's setup had it. */
  option?: {
    id: string;
    label: string | null;
    open: 'auto' | 'open' | 'closed';
    /** The option's typed note in that run's setup. */
    note: string | null;
    /** Only when closed. */
    closed?: ClosedProvenanceView;
  };
  /** Where the page links for it; tab null = nothing to link. */
  link: {
    tab: TeamSetSetupTab | null;
    field_id?: string;
    option_id?: string;
    pin_id?: string;
  };
}

// ─── Setup changes ──────────────────────────────────────────────────────────

/**
 * One difference between two configs (a run's setup and the current one, or
 * two runs'), compared on RESOLVED values: an unset non_respondents is its
 * default, an option's size is its effective bounds. `text` is a fixed
 * template ("'Studio': Solver decides → Closed", "Pin added: A → 'Studio'").
 * A priority rule's changes are `kind: 'rule', change: 'params'`.
 */
export type SetupChange =
  | {
      kind:
        | 'grouping'
        | 'team_size'
        | 'team_count'
        | 'non_respondents'
        | 'fairness'
        | 'team_name_template'
        | 'time_limit_s'
        | 'github_teams';
      before: unknown;
      after: unknown;
      text: string;
    }
  | {
      kind: 'option';
      option_id: string;
      field: 'open' | 'size' | 'note' | 'category' | 'team_name';
      before: unknown;
      after: unknown;
      text: string;
    }
  | {
      kind: 'rule';
      field_id: string;
      job: TeamSetJob;
      change: 'added' | 'removed' | 'strength' | 'weight' | 'params';
      before: unknown;
      after: unknown;
      text: string;
    }
  | { kind: 'pin'; pin_id: string; change: 'added' | 'removed'; pin: PinView; text: string };

// ─── Why this placement ─────────────────────────────────────────────────────

/**
 * One priority rule's effect on one person. `favored`/`other` are the labels
 * of the questions whose rules the answer counts more and less (`up` = 1 + s,
 * `down` = 1 − s); both null, and up = down = 1, when the answer changes
 * nothing.
 */
export interface PriorityFact {
  rule_id: string;
  /** The priority question's label. */
  question: string;
  /** The person's answer, as the option's label. */
  answer: string;
  favored: string | null;
  other: string | null;
  up: number;
  down: number;
}

/**
 * The facts behind one person's placement in a solved run, from that run's
 * own problem, context, config and result (plus the previous solved run).
 * Never an identity answer, never any answer other than a note rule's text.
 */
export interface PlacementFacts {
  user_id: string;
  name: string | null;
  responded: boolean;
  /** Set when the person didn't answer: how that run placed such people. */
  non_respondents_mode?: NonRespondentsMode;
  /** Seated in the second stage with the others who didn't answer. */
  grouped?: boolean;
  team: { n: number; name: string; option: OptionRef | null; mates: PersonRef[] };
  /**
   * How their team's option sat in their answer. null when that is not shown:
   * the service sets null when the answer it would be read from is on a
   * question that is an identity question now (placementFacts itself never
   * returns null).
   */
  placement: TeamSetPlacement | null;
  /**
   * 1-based position of their team's option in their answer as submitted;
   * null = not ranked, or not shown (the grouping question is an identity
   * question now).
   */
  rank: number | null;
  /** Options their owner-rule answers name. */
  pitched: { option: OptionRef; status: OptionStatus }[];
  /** Pins in that run's setup that name them. */
  pins: PinView[];
  /**
   * Where the latest earlier solved run put them, only when the option (or,
   * in free mode and when the service says so, the teammates) differed.
   */
  previous: { run_number: number; option: OptionRef | null; team_n: number } | null;
  /** Picks ranked above the one they got (every pick when they got none). */
  higher_picks: { rank: number; option: OptionRef; status: OptionStatus }[];
  /** Their together-rule asks. */
  requests: { user: PersonRef; kept: boolean; on: { team_n: number; option: OptionRef | null } }[];
  /** Their own answers to note-rule questions. */
  notes: { field_label: string; text: string }[];
  /** One per active priority rule they answered. */
  priority?: PriorityFact[];
}

/**
 * What a team card shows besides its members, from the run's own data.
 * `wanted_first` = people in the set who ranked this team's option 1st
 * (null in free mode); `seats.max` uses the option's own size when it has one.
 */
export interface TeamSignals {
  wanted_first: number | null;
  seats: { used: number; max: number };
  /** A pitcher of this option is on this team; null = the option has no pitcher in the set. */
  pitcher_on_team: boolean | null;
  /** Together-rule asks made by this team's members. */
  requests: { kept: number; total: number };
  /** Members named by a pin. */
  pinned: number;
  did_not_answer: number;
  /** Members on their 4th pick or lower. */
  fourth_or_lower: number;
  /** Per active balance rule: the team's average answer and the class's (null = no answers). */
  balance: { field_id: string; label: string; team_avg: number | null; class_avg: number | null }[];
}

// ─── Compare two runs ───────────────────────────────────────────────────────

export type CompareMetricKey =
  | 'first_choice'
  | 'top3'
  | 'requests_kept'
  | 'must_broken'
  | 'options_open'
  | 'rule_held';

/**
 * One metric in both runs. `delta` = run − other (null when either is null).
 * `of` carries the "x of y" totals (requests_kept, options_open, rule_held).
 */
export interface CompareMetricRow {
  key: CompareMetricKey;
  /** rule_held: which no_one_alone rule, and whether its question is an identity question. */
  rule_id?: string;
  identity?: boolean;
  run: number | null;
  other: number | null;
  delta: number | null;
  of?: { run: number | null; other: number | null };
  /** options_open: both runs opened exactly the same options. */
  same_set?: boolean;
}

/** Where a person sat in one of the two runs. */
export interface RunSeat {
  option: OptionRef | null;
  team_n: number;
  /** 1-based rank of that option in their answer; null = not ranked. */
  rank: number | null;
}

/**
 * A person in both runs whose option (or, in free mode, teammate set)
 * changed. Reasons are limited to pins and requests: the pin in `run`'s setup
 * that names them, and requests that involve them and flipped.
 */
export interface RunMover {
  user: PersonRef;
  /** In `other`. */
  from: RunSeat;
  /** In `run`. */
  to: RunSeat;
  pin?: { pin_id: string; kind: TeamSetPin['kind']; reason: string | null };
  requests: { kind: 'now_kept' | 'no_longer_kept'; asker: PersonRef; asked: PersonRef }[];
}

/** Run `run_number` compared with run `other_run_number`. */
export interface RunComparison {
  run_number: number;
  other_run_number: number;
  /** Setup changes from the other run's config to this run's. */
  changes: SetupChange[];
  metrics: CompareMetricRow[];
  moved: RunMover[];
  /** People in both runs on the same option (free mode: same teammates). */
  unchanged: number;
  /** People in this run only / in the other run only. */
  joined: number;
  left: number;
}

// ─── Create progress ────────────────────────────────────────────────────────

/** One team of a create: done, being made now, not started, or failed. */
export type CreateTeamState = 'done' | 'live' | 'queued' | 'failed';

export interface CreateTeamProgress {
  /** 1-based position in the run. */
  n: number;
  name: string;
  state: CreateTeamState;
  members_added: number;
  /** Members the team gets. */
  size: number;
  /** A GitHub team exists for it. */
  github_team: boolean;
  /** state 'failed': the reason, a CreateFailureReason (teamSet.service.ts). */
  failure?: string;
}

/** A set's create, as the Creating and Created screens show it. */
export interface CreateProgressView {
  status: TeamSetCreateStatus;
  run_number: number;
  /** 1 on the first claim, +1 per retry. */
  attempt: number;
  /** Teams in the create, and how many are finished. */
  total: number;
  done: number;
  counts: {
    teams_created: number;
    teams_failed: number;
    members_added: number;
    members_failed: number;
  };
  /** Members across every team. */
  members_total: number;
  claimed_by: PersonRef;
  /** ISO times. */
  started_at: string;
  finished_at: string | null;
  /** The tag the teams go under. */
  tag: { id: string | null; name: string };
  teams: CreateTeamProgress[];
  /** Teams whose planned name was taken, and the name they got. */
  renamed: { n: number; from: string; to: string }[];
  /**
   * `team` is the team's name, or '*' for a failure that stopped the whole
   * create. `reason` is a CreateFailureReason; a member's `reason` is a
   * CreateMemberFailureReason (both teamSet.service.ts).
   */
  failures: {
    team: string;
    reason: string;
    members?: { user_id: string; name: string | null; login: string | null; reason: string }[];
  }[];
}

// ════════════════════════════════════════════════════════════════════════════
// Inputs
// ════════════════════════════════════════════════════════════════════════════

/** One team of a run's result: user ids, in slot order (`team_set_runs.result`). */
export interface ExplainTeam {
  slot: number;
  /** null in free mode. */
  option_id: string | null;
  member_user_ids: string[];
}

/** A run as the helpers here read it: its own setup snapshot and outcome. */
export interface ExplainRun {
  number: number;
  config: TeamSetConfig;
  problem: TeamSetProblem;
  context: TeamSetContext;
  /** null (or no teams) when the run has no teams. */
  result: { teams: ExplainTeam[] } | null;
  metrics: TeamSetMetrics | null;
}

/**
 * Labels the templates fill in. Build them with `explainLabels` from the
 * fields of the revision the run (or the setup) used.
 */
export interface ExplainLabels {
  /** Question labels by field id. */
  fields: ReadonlyMap<string, string>;
  /** The grouping question's option labels by id; an id without one is no longer on the form. */
  options: ReadonlyMap<string, string>;
  /** Every option label of every question by option id (wildcard and priority answers). */
  choices?: ReadonlyMap<string, string>;
  /** Names by user id (null = the account has none). Absent: labels name no one, they count. */
  names?: ReadonlyMap<string, string | null>;
}

/** A question's label as the templates print it. */
function questionLabel(field: FormField): string {
  return typeof field.label === 'string' && field.label.trim() ? field.label : GONE_QUESTION;
}

/**
 * The label maps for a config over a list of fields (the run's revision, or
 * the current form for a setup). `names` is passed through.
 */
export function explainLabels(
  fields: readonly FormField[],
  config: Pick<TeamSetConfig, 'grouping'>,
  names?: ReadonlyMap<string, string | null>
): ExplainLabels {
  const fieldLabels = new Map<string, string>();
  const choices = new Map<string, string>();
  for (const field of fields) {
    fieldLabels.set(field.id, questionLabel(field));
    for (const option of fieldOptions(field)) {
      if (!choices.has(option.id)) choices.set(option.id, option.label);
    }
  }
  const options = new Map<string, string>();
  if (config.grouping.mode === 'by_option') {
    const groupingId = config.grouping.field_id;
    const grouping = fields.find(field => field.id === groupingId);
    for (const option of grouping ? fieldOptions(grouping) : [])
      options.set(option.id, option.label);
  }
  return { fields: fieldLabels, options, choices, ...(names ? { names } : {}) };
}

// ════════════════════════════════════════════════════════════════════════════
// Words
// ════════════════════════════════════════════════════════════════════════════

/** What a person without a name is called (the page's word too). */
const UNNAMED = 'Unnamed person';
const GONE_OPTION = 'An option no longer on the form';
const GONE_QUESTION = 'A question no longer on the form';
const LIMITS = 'the team-size, teams-per-option and team-count limits';

/** The longest note text a why panel carries; longer answers end in "…". */
export const NOTE_TEXT_MAX_CHARS = 500;

/** A rule's job as the labels print it: "(rank, must)", "(no one alone, prefer)" (teamSetConfig's words). */
export { TEAM_SET_JOB_WORDS };

/** How people who didn't answer were placed, as a Can't-solve item says it. */
const NON_RESPONDENT_PHRASES: Readonly<Record<TeamSetNonRespondents, string>> = {
  include: 'spread out',
  group: 'grouped together',
  exclude: 'left out',
};

/** The same, as a setup change says it. */
const NON_RESPONDENT_WORDS: Readonly<Record<TeamSetNonRespondents, string>> = {
  include: 'Spread',
  group: 'Group',
  exclude: 'Leave out',
};

/** An option's "Runs" setting. */
const OPEN_WORDS: Readonly<Record<'auto' | 'open' | 'closed', string>> = {
  auto: 'Solver decides',
  open: 'Always',
  closed: 'Closed',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function quoted(text: string): string {
  return `"${text}"`;
}

/** "3–5", or "4" when min = max. */
function sizeText(size: { min: number; max: number }): string {
  return size.min === size.max ? String(size.min) : `${size.min}–${size.max}`;
}

/** "one student", "two students", "3 students": how a name-free label counts people. */
function countedPeople(count: number): string {
  if (count === 1) return 'one student';
  if (count === 2) return 'two students';
  return plural(count, 'student');
}

function personRef(userId: string, names?: ReadonlyMap<string, string | null>): PersonRef {
  return { user_id: userId, name: names?.get(userId) ?? null };
}

/** A name for a template; UNNAMED when the account has none. */
function nameText(userId: string, names: ReadonlyMap<string, string | null>): string {
  return names.get(userId) ?? UNNAMED;
}

/** "'Studio'", or "an option no longer on the form". */
function optionText(optionId: string, labels: ExplainLabels): string {
  const label = labels.options.get(optionId);
  return label !== undefined ? `'${label}'` : GONE_OPTION.toLowerCase();
}

function optionRef(optionId: string, labels: ExplainLabels): OptionRef {
  return { id: optionId, label: labels.options.get(optionId) ?? null };
}

/** An option of any question (another run may group by another one): the grouping question's label first. */
function anyOptionRef(optionId: string, labels: ExplainLabels): OptionRef {
  return {
    id: optionId,
    label: labels.options.get(optionId) ?? labels.choices?.get(optionId) ?? null,
  };
}

/** "\"Rank the projects\"", or "A question no longer on the form". */
function questionText(fieldId: string, labels: ExplainLabels): string {
  const label = labels.fields.get(fieldId);
  return label !== undefined ? quoted(label) : GONE_QUESTION;
}

/** An answer's label: the option's, "Yes"/"No" for a switch, or a fixed phrase. */
function answerText(key: string, labels: ExplainLabels): string {
  if (key === 'true') return 'Yes';
  if (key === 'false') return 'No';
  return labels.choices?.get(key) ?? labels.options.get(key) ?? 'An answer no longer on the form';
}

/** People sorted by name (unnamed last), then id — a stable reading order. */
function byName(a: PersonRef, b: PersonRef): number {
  if (a.name !== null && b.name !== null) {
    const order = a.name.localeCompare(b.name);
    if (order !== 0) return order;
  } else if (a.name !== b.name) {
    return a.name === null ? 1 : -1;
  }
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

/** Two decimals at most, so a stored or sent average stays short. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ════════════════════════════════════════════════════════════════════════════
// Pins
// ════════════════════════════════════════════════════════════════════════════

/** Everyone a pin names, in the pin's order. */
function pinPeople(pin: TeamSetPin): string[] {
  return pin.kind === 'together' || pin.kind === 'apart' ? pin.user_ids : [pin.user_id];
}

/** A pin with names and labels resolved. */
export function toPinView(pin: TeamSetPin, labels: ExplainLabels): PinView {
  return {
    id: pin.id,
    kind: pin.kind,
    people: pinPeople(pin).map(id => personRef(id, labels.names)),
    option: pin.kind === 'on_option' ? optionRef(pin.option_id, labels) : null,
    ...(pin.kind === 'not_options'
      ? { options: pin.option_ids.map(id => optionRef(id, labels)) }
      : {}),
    reason: pin.reason ?? null,
    added_by: pin.added_by ? personRef(pin.added_by, labels.names) : null,
    added_via: pin.added_via ?? null,
    added_at: pin.added_at ?? null,
  };
}

/**
 * What a pin says, without its reason: "Ana Ruiz → 'Studio'", "Ana Ruiz not
 * on 'Pulse', 'Echo'", "together — Ana Ruiz, Ben Osei", "apart — …". Without
 * names: "one student → 'Studio'", "together — 3 students".
 */
function pinPhrase(pin: TeamSetPin, labels: ExplainLabels): string {
  const names = labels.names;
  const one = (id: string) => (names ? nameText(id, names) : countedPeople(1));
  const group = (ids: string[]) =>
    names ? ids.map(id => nameText(id, names)).join(', ') : countedPeople(ids.length);
  switch (pin.kind) {
    case 'on_option':
      return `${one(pin.user_id)} → ${optionText(pin.option_id, labels)}`;
    case 'not_options':
      return `${one(pin.user_id)} not on ${pin.option_ids.map(id => optionText(id, labels)).join(', ')}`;
    case 'together':
      return `together — ${group(pin.user_ids)}`;
    case 'apart':
      return `apart — ${group(pin.user_ids)}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Can't solve: labelSrc
// ════════════════════════════════════════════════════════════════════════════

/** What labelSrc reads: the unsolved run's own snapshot, labels, and closed provenance. */
export interface SrcLabelContext {
  run: Pick<ExplainRun, 'config' | 'problem' | 'context'>;
  labels: ExplainLabels;
  /** Per closed option of this run: closedProvenance(runs, null, run.number). */
  closed?: ReadonlyMap<string, ClosedProvenance>;
  /**
   * The run's revision fields: a whole-rule Must item then carries its Must
   * sentence (ruleMustLabel). The owner rule's needs no field.
   */
  fields?: readonly FormField[];
}

/** The Must sentence for a whole-rule src, when the rule has one. */
function wholeRuleMustLabel(
  parsed: Extract<ParsedSrc, { kind: 'rule' }>,
  ctx: SrcLabelContext
): string | null {
  const rule = ctx.run.config.rules.find(entry => teamSetRuleId(entry) === parsed.rule_id);
  const field =
    ctx.fields?.find(entry => entry.id === parsed.field_id) ??
    // The owner sentence doesn't depend on the question's type.
    (parsed.job === 'owner' ? { id: parsed.field_id, type: 'dropdown' as const } : undefined);
  if (!field) return null;
  return ruleMustLabel({ job: parsed.job, params: rule?.params ?? {} }, field);
}

/** ClosedProvenance with `by` resolved to a person (name null without names). */
export function closedProvenanceView(
  provenance: ClosedProvenance,
  names?: ReadonlyMap<string, string | null>
): ClosedProvenanceView {
  return {
    since_run: provenance.since_run,
    by: provenance.by ? personRef(provenance.by, names) : null,
    via: provenance.via,
  };
}

/** An option as the run's setup had it, for option and size items. */
function coreOption(optionId: string, ctx: SrcLabelContext): NonNullable<CoreItem['option']> {
  const { run, labels } = ctx;
  const open =
    run.problem.options.find(option => option.id === optionId)?.open ??
    run.config.options[optionId]?.open ??
    'auto';
  const provenance = open === 'closed' ? ctx.closed?.get(optionId) : undefined;
  return {
    id: optionId,
    label: labels.options.get(optionId) ?? null,
    open,
    note: run.config.options[optionId]?.note ?? null,
    ...(provenance ? { closed: closedProvenanceView(provenance, labels.names) } : {}),
  };
}

/**
 * One src of an unsolved run's conflict list as the page shows it:
 *   rule, one person   "Rank the projects (rank, must)" + people [Ana Ruiz]
 *   rule, a pair       "Who would you like to work with? (together, must)" + people [A, B]
 *                      (the page puts the names before the label)
 *   rule, one option   "'Pulse' · Did you pitch one? (owner, must) · A project runs
 *                      only with one of its pitchers on it" (the owner rule at
 *                      Must, `<rule>#<option id>`), with the option as that
 *                      run had it and a link to its Projects row
 *   rule, whole rule   "Does a timing suit you? (match, must) · …" — the Must
 *                      sentence is added for the owner rule always, for other
 *                      jobs when `ctx.fields` is given
 *   option             "'Pulse' is closed" / "'Pulse' always runs"
 *   size               "'Studio' teams of 2–3"
 *   pin                "Pin: Ana Ruiz → 'Studio' · \"Has a badge\""
 *   non_respondents    "People who didn't answer: grouped together" (the run's
 *                      resolved mode: spread out / grouped together)
 * Without `labels.names` a pin's people are counted ("Pin: together — 3
 * students") and `people` carry null names: the name-free label a run
 * stores. The link points at the Setup row to change.
 */
export function labelSrc(src: string, ctx: SrcLabelContext): CoreItem {
  const { run, labels } = ctx;
  const parsed = parseSrc(src);
  switch (parsed.kind) {
    case 'rule': {
      const link = { tab: 'questions' as const, field_id: parsed.field_id };
      const userIds = parsed.people
        .map(p => run.problem.people[p])
        .filter((id): id is string => id !== undefined);
      const job = TEAM_SET_JOB_WORDS[parsed.job];
      const rule = run.context.rules.find(entry => entry.id === parsed.rule_id);
      const question = rule?.label.trim() ? rule.label : labels.fields.get(parsed.field_id);
      const strength =
        rule?.strength ??
        run.config.rules.find(entry => teamSetRuleId(entry) === parsed.rule_id)?.strength ??
        'must';
      const what =
        question !== undefined
          ? `${question} (${job}, ${strength})`
          : `A ${job} rule on a question no longer on the form`;
      if (parsed.option_id !== undefined) {
        const must = strength === 'must' ? wholeRuleMustLabel(parsed, ctx) : null;
        const project = capitalize(optionText(parsed.option_id, labels));
        return {
          src,
          kind: 'rule',
          label: [project, what, ...(must ? [must] : [])].join(' · '),
          option: coreOption(parsed.option_id, ctx),
          link: { tab: 'projects', option_id: parsed.option_id },
        };
      }
      if (parsed.people.length === 0) {
        const must = strength === 'must' ? wholeRuleMustLabel(parsed, ctx) : null;
        return { src, kind: 'rule', label: must ? `${what} · ${must}` : what, link };
      }
      // Per student: the rule part only; the page names them from `people`.
      const people = userIds.length
        ? { user_ids: userIds, people: userIds.map(id => personRef(id, labels.names)) }
        : {};
      return { src, kind: 'rule', label: what, ...people, link };
    }

    case 'pin': {
      const link = { tab: 'pins' as const, pin_id: parsed.pin_id };
      const pin = run.config.pins.find(entry => entry.id === parsed.pin_id);
      if (!pin) {
        const stored = run.context.pins.find(entry => entry.id === parsed.pin_id);
        const label = stored ? `Pin: ${stored.label}` : 'A pin no longer in this setup';
        return { src, kind: 'pin', label, link };
      }
      const reason = pin.reason ? ` · ${quoted(pin.reason)}` : '';
      return {
        src,
        kind: 'pin',
        label: `Pin: ${pinPhrase(pin, labels)}${reason}`,
        user_ids: [...pinPeople(pin)],
        link,
      };
    }

    case 'option': {
      const option = coreOption(parsed.option_id, ctx);
      const subject = capitalize(optionText(parsed.option_id, labels));
      const label =
        option.open === 'closed'
          ? `${subject} is closed`
          : option.open === 'open'
            ? `${subject} always runs`
            : `${subject}: ${OPEN_WORDS.auto}`;
      return {
        src,
        kind: 'option',
        label,
        option,
        link: { tab: 'projects', option_id: parsed.option_id },
      };
    }

    case 'size': {
      const own = run.problem.options.find(entry => entry.id === parsed.option_id)?.size;
      const size = own ?? optionSize(run.config, parsed.option_id);
      return {
        src,
        kind: 'size',
        label: `${capitalize(optionText(parsed.option_id, labels))} teams of ${sizeText(size)}`,
        option: coreOption(parsed.option_id, ctx),
        link: { tab: 'projects', option_id: parsed.option_id },
      };
    }

    case 'non_respondents':
      return {
        src,
        kind: 'non_respondents',
        label: `People who didn't answer: ${NON_RESPONDENT_PHRASES[resolveNonRespondents(run.config)]}`,
        link: { tab: 'non_respondents' },
      };

    default:
      return {
        src,
        kind: 'unknown',
        label: 'Another setting of this team set',
        link: { tab: null },
      };
  }
}

/**
 * labelSrc over a core, each src once, in the engine's order — with the
 * per-student items of one rule (`<rule>@p`, `<rule>@p+q`) merged into one
 * line where the rule's first one was: src = the rule id, `people` and
 * `user_ids` = all of their students, each once, in the engine's order.
 * Pair items keep who is with whom in `pairs` (positions in `people`).
 */
export function coreItems(srcs: readonly string[], ctx: SrcLabelContext): CoreItem[] {
  const items: CoreItem[] = [];
  const merged = new Map<string, CoreItem>();
  for (const src of new Set(srcs)) {
    const item = labelSrc(src, ctx);
    const parsed = parseSrc(src);
    if (parsed.kind !== 'rule' || parsed.people.length === 0) {
      items.push(item);
      continue;
    }
    const pair = parsed.people.length === 2 && item.people?.length === 2;
    const first = merged.get(parsed.rule_id);
    if (!first) {
      if (pair) item.pairs = [[0, 1]];
      merged.set(parsed.rule_id, item);
      items.push(item);
      continue;
    }
    const people = [...(first.people ?? [])];
    const position = new Map(people.map((person, i) => [person.user_id, i]));
    for (const person of item.people ?? []) {
      if (position.has(person.user_id)) continue;
      position.set(person.user_id, people.length);
      people.push(person);
    }
    first.src = parsed.rule_id;
    first.people = people;
    first.user_ids = people.map(person => person.user_id);
    if (pair) {
      const [a, b] = item.people!;
      first.pairs = [...(first.pairs ?? []), [position.get(a.user_id)!, position.get(b.user_id)!]];
    }
  }
  return items;
}

// ════════════════════════════════════════════════════════════════════════════
// Can't solve: the sentence
// ════════════════════════════════════════════════════════════════════════════

const SOLVED_STATUSES: ReadonlySet<string> = new Set(['OPTIMAL', 'FEASIBLE']);

/**
 * The one sentence an INFEASIBLE run carries. Facts only; what to change is
 * the MCP tools' hint, never this sentence.
 *   a core            "The settings listed can't all be met together within …"
 *                     (+ a line when the engine stopped before it was the
 *                     shortest list: `core_status` 'timeout')
 *   no core, complete the limits alone can't place everyone
 *   no core, timeout  no teams meet the rules; which settings conflict wasn't found
 *   group mode        the first stage placed everyone who answered and the
 *                     second couldn't seat the `group` people who didn't,
 *                     within the size and count limits, on the options that
 *                     can still take a team
 */
export function infeasibleSummary(facts: {
  /** How many srcs the core names. */
  core: number;
  core_status?: 'complete' | 'timeout' | 'n/a';
  /** The engine's stages (group mode only). */
  stages?: TeamSetSolveStages | null;
  /** People seated in the second stage (problem.group.members.length). */
  group?: number;
  /** The set makes free teams (no grouping question). */
  free?: boolean;
}): string {
  // Stage 1 placed everyone who answered; stage 2 couldn't seat the rest. A
  // stage-1 INFEASIBLE takes the core sentences below like any other run.
  const { stages } = facts;
  const secondSolved = stages?.second ? SOLVED_STATUSES.has(stages.second.status) : false;
  if (stages && SOLVED_STATUSES.has(stages.first.status) && !secondSolved) {
    const n = facts.group ?? 0;
    const who = n === 1 ? "1 person who didn't answer" : `${n} people who didn't answer`;
    if (facts.free) {
      return n === 1
        ? `${who} can't be seated within the team-size and team-count limits.`
        : `${who} can't be seated together within the team-size and team-count limits.`;
    }
    // True whatever stopped it: the slots stage 1 used, an owner-Must option
    // stage 1 didn't open, the group's own size caps, the team count left.
    return n === 1
      ? `${who} can't be seated within the team-size and team-count limits on an option that can still take a team.`
      : `${who} can't be seated together within the team-size and team-count limits on the options that can still take a team.`;
  }
  const base = `The settings listed can't all be met together within ${LIMITS}.`;
  if (facts.core > 0) {
    return facts.core_status === 'timeout'
      ? `${base} Some settings listed may not be part of the conflict.`
      : base;
  }
  if (facts.core_status === 'complete') {
    return `The team-size, teams-per-option and team-count limits alone can't place everyone.`;
  }
  const none = `No teams meet every Must rule and pin within ${LIMITS}.`;
  return facts.core_status === 'timeout'
    ? `${none} The settings that conflict weren't identified.`
    : none;
}

// ════════════════════════════════════════════════════════════════════════════
// Run index (shared by the why facts, team signals and compare)
// ════════════════════════════════════════════════════════════════════════════

type ContextPerson = TeamSetContext['people'][number];

interface RunIndex {
  /** Free mode: the one synthetic option. */
  free: boolean;
  /** user id → index into result.teams. */
  teamOf: Map<string, number>;
  /** user id → person index into problem.people. */
  personIndex: Map<string, number>;
  person: Map<string, ContextPerson>;
  /** option id → index into problem.options. */
  optionIndex: Map<string, number>;
  statuses: Map<string, OptionStatus>;
  teams: ExplainTeam[];
}

function isFreeProblem(problem: Pick<TeamSetProblem, 'options'>): boolean {
  return problem.options.length === 1 && problem.options[0]?.id === FREE_OPTION_ID;
}

/**
 * How a run left every option of its problem, keyed by option id. An id that
 * is not in the problem (statusOf) is `not_on_form`.
 */
export function optionStatuses(
  run: Pick<ExplainRun, 'problem' | 'result'>
): Map<string, OptionStatus> {
  const { problem } = run;
  const placed = problem.options.map(() => 0);
  const slots = problem.options.map(() => 0);
  const over = problem.options.map(() => 0);
  const teamMax = (o: number) => problem.options[o]?.size?.max ?? problem.size.max;
  for (const slot of problem.slots) if (slots[slot.option] !== undefined) slots[slot.option] += 1;
  for (const team of run.result?.teams ?? []) {
    const o = problem.slots[team.slot]?.option;
    if (o === undefined || placed[o] === undefined) continue;
    placed[o] += team.member_user_ids.length;
    if (team.member_user_ids.length === teamMax(o) + 1) over[o]! += 1;
  }
  const statuses = new Map<string, OptionStatus>();
  problem.options.forEach((option, o) => {
    const max = slots[o]! * teamMax(o) + over[o]!;
    let status: OptionRunState;
    if (option.open === 'closed') status = 'closed';
    else if (placed[o] === 0) status = 'not_running';
    else if (placed[o]! >= max) status = 'full';
    else status = 'running';
    statuses.set(option.id, { status, placed: placed[o]!, max });
  });
  return statuses;
}

function statusOf(statuses: ReadonlyMap<string, OptionStatus>, optionId: string): OptionStatus {
  return statuses.get(optionId) ?? { status: 'not_on_form', placed: 0, max: 0 };
}

function indexRun(run: Pick<ExplainRun, 'problem' | 'context' | 'result'>): RunIndex {
  const teams = run.result?.teams ?? [];
  const teamOf = new Map<string, number>();
  teams.forEach((team, t) => {
    for (const userId of team.member_user_ids) teamOf.set(userId, t);
  });
  return {
    free: isFreeProblem(run.problem),
    teamOf,
    personIndex: new Map(run.problem.people.map((userId, p) => [userId, p])),
    person: new Map(run.context.people.map(person => [person.user_id, person])),
    optionIndex: new Map(run.problem.options.map((option, o) => [option.id, o])),
    statuses: optionStatuses(run),
    teams,
  };
}

/** A team's option id (null in free mode); from the slot when the row has none. */
function teamOption(run: Pick<ExplainRun, 'problem'>, ix: RunIndex, t: number): string | null {
  if (ix.free) return null;
  const team = ix.teams[t];
  if (!team) return null;
  return (
    team.option_id ?? run.problem.options[run.problem.slots[team.slot]?.option ?? -1]?.id ?? null
  );
}

/** 1-based position of an option in the person's answer as submitted; null = not ranked. */
function rankOf(person: ContextPerson | undefined, optionId: string | null): number | null {
  if (optionId === null || !person) return null;
  const position = person.ranked.indexOf(optionId);
  return position === -1 ? null : position + 1;
}

/** Same classification as computeMetrics (teamSetMetrics.ts), for one person. */
function placementOf(
  run: Pick<ExplainRun, 'context'>,
  ix: RunIndex,
  person: ContextPerson | undefined,
  optionId: string | null
): TeamSetPlacement {
  const ranked = person?.ranked ?? [];
  if (ix.free || ranked.length === 0) return 'no_answer';
  const position = optionId === null ? -1 : ranked.indexOf(optionId);
  if (position !== -1) return position < 4 ? (String(position + 1) as TeamSetPlacement) : '5+';
  const o = optionId === null ? undefined : ix.optionIndex.get(optionId);
  const category = o === undefined ? null : (run.context.option_categories?.[o] ?? null);
  if (category !== null && (person?.categories ?? []).includes(category)) return 'fallback';
  return 'missed';
}

// ════════════════════════════════════════════════════════════════════════════
// Why this placement
// ════════════════════════════════════════════════════════════════════════════

export interface PlacementFactsInput {
  /** A SOLVED run (a run without teams gives no facts). */
  run: ExplainRun;
  /** Team names, index-aligned with run.result.teams (the names the service plans). */
  teamNames: readonly string[];
  /** The latest SOLVED run numbered below `run`, or null. */
  previous?: Pick<ExplainRun, 'number' | 'result'> | null;
  /**
   * `previous` is set when the teammates differ (as in free mode) rather than
   * the option: the service's choice when either run's grouping question is
   * an identity question now.
   */
  previousByTeammates?: boolean;
  /**
   * The fields of the revision the run used: note questions, the priority
   * question's answers, and identity flags (identity questions are skipped
   * everywhere).
   */
  fields: readonly FormField[];
  labels: ExplainLabels;
  /** Submitted answers by user id. Only note-rule text is read from them (and owner answers on runs compiled before `pitched`). */
  answers?: ReadonlyMap<string, Record<string, unknown>>;
  /** Only these people; everyone in the run when absent. */
  userIds?: readonly string[];
}

/** The note questions of a run: active note rules, never an identity or email question. */
function noteFields(run: ExplainRun, fields: ReadonlyMap<string, FormField>): FormField[] {
  const ids =
    run.context.note_field_ids ??
    run.config.rules
      .filter(rule => rule.job === 'note' && rule.strength !== 'off')
      .map(rule => rule.field_id);
  return [...new Set(ids)]
    .map(id => fields.get(id))
    .filter(
      (field): field is FormField =>
        field !== undefined && !isIdentityQuestion(field) && field.type !== 'email'
    );
}

function noteText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  return text.length > NOTE_TEXT_MAX_CHARS ? `${text.slice(0, NOTE_TEXT_MAX_CHARS)}…` : text;
}

/** Options a person pitched: from the context, else (older runs) from their owner answers. */
function pitchedOf(
  run: ExplainRun,
  ix: RunIndex,
  person: ContextPerson | undefined,
  answers: Record<string, unknown> | undefined
): string[] {
  if (ix.free) return [];
  if (person?.pitched) return person.pitched;
  if (!answers) return [];
  const pitched: string[] = [];
  for (const rule of run.context.rules) {
    if (rule.job !== 'owner') continue;
    const raw = answers[rule.field_id ?? rule.id.split(':')[0] ?? ''];
    const ids = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    const id = ids.find(
      (value): value is string => typeof value === 'string' && ix.optionIndex.has(value)
    );
    if (id !== undefined && !pitched.includes(id)) pitched.push(id);
  }
  return pitched;
}

/** A question label for a rule id: the labels map, else the run's context. */
function ruleQuestion(ruleId: string, run: ExplainRun, labels: ExplainLabels): string {
  const parsed = parseSrc(ruleId);
  const fieldId = parsed.kind === 'rule' ? parsed.field_id : '';
  return (
    labels.fields.get(fieldId) ??
    run.context.rules.find(rule => rule.id === ruleId)?.label ??
    GONE_QUESTION
  );
}

/** A person's priority facts, one per active priority rule they answered (never an identity question). */
function priorityFacts(
  run: ExplainRun,
  person: ContextPerson | undefined,
  fields: ReadonlyMap<string, FormField>,
  labels: ExplainLabels
): PriorityFact[] {
  const facts: PriorityFact[] = [];
  for (const entry of person?.priority ?? []) {
    const rule = run.config.rules.find(
      candidate => candidate.job === 'priority' && teamSetRuleId(candidate) === entry.rule_id
    );
    if (!rule || rule.strength === 'off') continue;
    const field = fields.get(rule.field_id);
    if (field && isIdentityQuestion(field)) continue;
    const effect = rule.params.answers?.[entry.option_id] ?? 'none';
    const question =
      labels.fields.get(rule.field_id) ?? (field ? questionLabel(field) : GONE_QUESTION);
    const answer = answerText(entry.option_id, labels);
    const { rule_a: a, rule_b: b } = rule.params;
    if (effect === 'none' || a === undefined || b === undefined) {
      facts.push({
        rule_id: entry.rule_id,
        question,
        answer,
        favored: null,
        other: null,
        up: 1,
        down: 1,
      });
      continue;
    }
    const shift = priorityShift(rule);
    const [favored, other] = effect === 'a' ? [a, b] : [b, a];
    facts.push({
      rule_id: entry.rule_id,
      question,
      answer,
      favored: ruleQuestion(favored, run, labels),
      other: ruleQuestion(other, run, labels),
      up: (100 + shift) / 100,
      down: (100 - shift) / 100,
    });
  }
  return facts;
}

/**
 * The why facts for the people of a solved run: their team and teammates,
 * their rank, what they pitched and how it ran, the pins that name them,
 * where the previous solved run put them (when that differs), the picks above
 * the one they got with each option's status, their together requests (kept
 * or where the other person is), their own note answers, and what their
 * priority answers did. Nothing else from their answers.
 */
export function placementFacts(input: PlacementFactsInput): PlacementFacts[] {
  const { run, labels } = input;
  if (!run.result) return [];
  const ix = indexRun(run);
  const fieldById = new Map(input.fields.map(field => [field.id, field]));
  const notes = noteFields(run, fieldById);
  const only = input.userIds ? new Set(input.userIds) : null;
  const previous = input.previous?.result ? input.previous : null;
  const previousTeamOf = new Map<string, number>();
  previous?.result?.teams.forEach((team, t) => {
    for (const userId of team.member_user_ids) previousTeamOf.set(userId, t);
  });
  const mode = resolveNonRespondents(run.config);
  const groupMembers = new Set(run.problem.group?.members ?? []);

  const facts: PlacementFacts[] = [];
  run.problem.people.forEach((userId, p) => {
    if (only && !only.has(userId)) return;
    const t = ix.teamOf.get(userId);
    if (t === undefined) return;
    const team = ix.teams[t]!;
    const person = ix.person.get(userId);
    const optionId = teamOption(run, ix, t);
    const responded = person?.responded ?? false;
    const answers = input.answers?.get(userId);
    const ref = (id: string | null) => (id === null ? null : optionRef(id, labels));

    let previousSeat: PlacementFacts['previous'] = null;
    const pt = previousTeamOf.get(userId);
    if (previous && pt !== undefined) {
      const before = previous.result!.teams[pt]!;
      const beforeOption = ix.free ? null : before.option_id;
      const moved =
        ix.free || input.previousByTeammates
          ? !sameMembers(
              before.member_user_ids.filter(id => id !== userId),
              team.member_user_ids.filter(id => id !== userId)
            )
          : beforeOption !== optionId;
      if (moved) {
        previousSeat = {
          run_number: previous.number,
          option: beforeOption === null ? null : anyOptionRef(beforeOption, labels),
          team_n: pt + 1,
        };
      }
    }

    const ranked = ix.free ? [] : (person?.ranked ?? []);
    const position = optionId === null ? -1 : ranked.indexOf(optionId);
    const higher = position === -1 ? ranked : ranked.slice(0, position);

    const fact: PlacementFacts = {
      user_id: userId,
      name: labels.names?.get(userId) ?? null,
      responded,
      ...(responded ? {} : { non_respondents_mode: mode }),
      ...(groupMembers.has(p) ? { grouped: true } : {}),
      team: {
        n: t + 1,
        name: input.teamNames[t] ?? `Team ${t + 1}`,
        option: ref(optionId),
        mates: team.member_user_ids
          .filter(id => id !== userId)
          .map(id => personRef(id, labels.names))
          .sort(byName),
      },
      placement: placementOf(run, ix, person, optionId),
      rank: ix.free ? null : rankOf(person, optionId),
      pitched: pitchedOf(run, ix, person, answers).map(id => ({
        option: optionRef(id, labels),
        status: statusOf(ix.statuses, id),
      })),
      pins: run.config.pins
        .filter(pin => pinPeople(pin).includes(userId))
        .map(pin => toPinView(pin, labels)),
      previous: previousSeat,
      higher_picks: higher.map((id, i) => ({
        rank: i + 1,
        option: optionRef(id, labels),
        status: statusOf(ix.statuses, id),
      })),
      requests: (person?.requests ?? []).flatMap(asked => {
        const at = ix.teamOf.get(asked);
        if (at === undefined) return [];
        return [
          {
            user: personRef(asked, labels.names),
            kept: at === t,
            on: { team_n: at + 1, option: ref(teamOption(run, ix, at)) },
          },
        ];
      }),
      notes: notes.flatMap(field => {
        const text = noteText(answers?.[field.id]);
        return text === null ? [] : [{ field_label: questionLabel(field), text }];
      }),
    };
    const priority = priorityFacts(run, person, fieldById, labels);
    if (priority.length > 0) fact.priority = priority;
    facts.push(fact);
  });
  return facts;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(id => set.has(id));
}

// ════════════════════════════════════════════════════════════════════════════
// Team cards
// ════════════════════════════════════════════════════════════════════════════

/**
 * Each team's signals, index-aligned with run.result.teams:
 *   wanted_first     people in the set whose first pick is the team's option
 *   seats            members of the team's max size (its max + 1 on a team one
 *                    over its size, the remainder flex)
 *   pitcher_on_team  null when nobody in the set pitched the option (or the
 *                    run predates pitched facts)
 *   requests         together asks made by its members, kept = the asked
 *                    person is on the same team
 *   pinned           members any pin names
 *   did_not_answer   members without a response
 *   fourth_or_lower  members on their 4th pick or lower; someone on an option
 *                    they didn't rank is on no pick, so not counted
 *   balance          per active balance rule (never an identity rule): the
 *                    team's and the class's average answer
 */
export function teamSignals(
  run: ExplainRun,
  labels?: Pick<ExplainLabels, 'fields'>
): TeamSignals[] {
  if (!run.result) return [];
  const ix = indexRun(run);
  const pinned = new Set(run.config.pins.flatMap(pinPeople));
  const firsts = new Map<string, number>();
  const pitchers = new Map<string, Set<string>>();
  let pitchKnown = false;
  for (const person of run.context.people) {
    const first = person.ranked[0];
    if (first !== undefined) firsts.set(first, (firsts.get(first) ?? 0) + 1);
    if (person.pitched) pitchKnown = true;
    for (const optionId of person.pitched ?? []) {
      const set = pitchers.get(optionId) ?? new Set<string>();
      set.add(person.user_id);
      pitchers.set(optionId, set);
    }
  }
  const identityRules = new Set(
    run.context.rules.filter(rule => rule.identity === true).map(rule => rule.id)
  );
  const balances = (run.context.balance ?? [])
    .filter(entry => !identityRules.has(entry.src))
    .map(entry => {
      const present = entry.values.filter((value): value is number => value !== null);
      const label =
        run.context.rules.find(rule => rule.id === entry.src)?.label ??
        labels?.fields.get(entry.field_id) ??
        GONE_QUESTION;
      return {
        entry,
        label,
        classAvg: present.length
          ? round2(present.reduce((a, b) => a + b, 0) / present.length)
          : null,
      };
    });

  return ix.teams.map((team, t) => {
    const optionId = teamOption(run, ix, t);
    const members = team.member_user_ids;
    const o = optionId === null ? undefined : ix.optionIndex.get(optionId);
    const size = (o === undefined ? undefined : run.problem.options[o]?.size) ?? run.problem.size;
    // A solved run holds its caps, so a team at max + 1 is one the flex allowed.
    const larger = members.length === size.max + 1;
    const optionPitchers = optionId === null ? undefined : pitchers.get(optionId);

    const requests = { kept: 0, total: 0 };
    let dnf = 0;
    let fourth = 0;
    for (const userId of members) {
      const person = ix.person.get(userId);
      if (!(person?.responded ?? false)) dnf += 1;
      const rank = ix.free ? null : rankOf(person, optionId);
      if (rank !== null && rank >= 4) fourth += 1;
      for (const asked of person?.requests ?? []) {
        const at = ix.teamOf.get(asked);
        if (at === undefined) continue;
        requests.total += 1;
        if (at === t) requests.kept += 1;
      }
    }

    return {
      wanted_first: ix.free || optionId === null ? null : (firsts.get(optionId) ?? 0),
      seats: { used: members.length, max: larger ? size.max + 1 : size.max },
      pitcher_on_team:
        ix.free || !pitchKnown || !optionPitchers || optionPitchers.size === 0
          ? null
          : members.some(userId => optionPitchers.has(userId)),
      requests,
      pinned: members.filter(userId => pinned.has(userId)).length,
      did_not_answer: dnf,
      fourth_or_lower: fourth,
      balance: balances.map(({ entry, label, classAvg }) => {
        const values = members
          .map(userId => {
            const p = ix.personIndex.get(userId);
            return p === undefined ? null : (entry.values[p] ?? null);
          })
          .filter((value): value is number => value !== null);
        return {
          field_id: entry.field_id,
          label,
          team_avg: values.length
            ? round2(values.reduce((a, b) => a + b, 0) / values.length)
            : null,
          class_avg: classAvg,
        };
      }),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Setup changes: diffConfigs
// ════════════════════════════════════════════════════════════════════════════

type Grouping = TeamSetConfig['grouping'];

function groupingText(grouping: Grouping, labels: ExplainLabels): string {
  return grouping.mode === 'free' ? 'free teams' : questionText(grouping.field_id, labels);
}

function countText(count: TeamSetConfig['team_count']): string {
  const { min, max } = count;
  if (min === undefined && max === undefined) return 'any';
  if (min !== undefined && max !== undefined) return sizeText({ min, max });
  return min !== undefined ? `at least ${min}` : `at most ${max}`;
}

/** Jobs whose weight means nothing: shown as On/Off. */
const WEIGHTLESS_JOBS: readonly TeamSetJob[] = ['note', 'priority'];

function strengthText(rule: TeamSetRule): string {
  if (rule.strength === 'off') return 'off';
  if (rule.strength === 'must') return 'must';
  return WEIGHTLESS_JOBS.includes(rule.job) ? 'on' : `prefer ${rule.weight}`;
}

/** A rule named in a priority rule: "\"Rank the projects\" (rank)", or "none". */
function ruleRefText(ruleId: string | undefined, labels: ExplainLabels): string {
  if (ruleId === undefined) return 'none';
  const parsed = parseSrc(ruleId);
  if (parsed.kind !== 'rule') return GONE_QUESTION;
  return `${questionText(parsed.field_id, labels)} (${TEAM_SET_JOB_WORDS[parsed.job]})`;
}

function priorityEffect(
  effect: 'a' | 'b' | 'none' | undefined,
  params: TeamSetRuleParams,
  labels: ExplainLabels
): string {
  if (effect === 'a' || effect === 'b') {
    const target = effect === 'a' ? params.rule_a : params.rule_b;
    const parsed = target === undefined ? null : parseSrc(target);
    const name =
      parsed?.kind === 'rule' ? questionText(parsed.field_id, labels) : effect.toUpperCase();
    return `${name} counts more`;
  }
  return 'no change';
}

/** The params a rule diff reads, in the order the changes are listed. */
const PARAM_ORDER: readonly (keyof TeamSetRuleParams)[] = [
  'rank_costs',
  'unranked_cost',
  'fallback_cost',
  'must_top',
  'wildcard_option_ids',
  'mutual_only',
  'max_per_team',
  'rule_a',
  'rule_b',
  'answers',
  'shift',
];

/** A param as its rule means it when unset, so unset and the default compare equal. */
function resolvedParam(key: keyof TeamSetRuleParams, params: TeamSetRuleParams): unknown {
  const value = params[key];
  if (key === 'mutual_only') return value ?? true;
  if (key === 'shift') return value ?? DEFAULT_PRIORITY_SHIFT;
  return value;
}

function answerList(ids: readonly string[] | undefined, labels: ExplainLabels): string {
  if (!ids || ids.length === 0) return 'none';
  return ids.map(id => quoted(answerText(id, labels))).join(', ');
}

/** One text per changed param (one per answer for a priority rule's answers). */
function paramChanges(
  before: TeamSetRule,
  after: TeamSetRule,
  labels: ExplainLabels
): { before: unknown; after: unknown; text: string }[] {
  const changes: { before: unknown; after: unknown; text: string }[] = [];
  const keys = [
    ...PARAM_ORDER,
    ...[...new Set([...Object.keys(before.params), ...Object.keys(after.params)])]
      .filter(key => !PARAM_ORDER.includes(key as keyof TeamSetRuleParams))
      .sort(),
  ] as (keyof TeamSetRuleParams)[];
  for (const key of keys) {
    const a = resolvedParam(key, before.params);
    const b = resolvedParam(key, after.params);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const orDefault = (value: unknown) => (value === undefined ? 'default' : String(value));
    switch (key) {
      case 'rank_costs': {
        const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : 'default');
        changes.push({ before: a, after: b, text: `rank costs ${list(a)} → ${list(b)}` });
        break;
      }
      case 'unranked_cost':
        changes.push({
          before: a,
          after: b,
          text: `cost of an unranked option ${orDefault(a)} → ${orDefault(b)}`,
        });
        break;
      case 'fallback_cost':
        changes.push({
          before: a,
          after: b,
          text: `cost of an option in a chosen category ${orDefault(a)} → ${orDefault(b)}`,
        });
        break;
      case 'must_top': {
        const top = (value: unknown) => (value === undefined ? 'every pick' : `the top ${value}`);
        changes.push({ before: a, after: b, text: `Must covers ${top(a)} → ${top(b)}` });
        break;
      }
      case 'wildcard_option_ids':
        changes.push({
          before: a,
          after: b,
          text: `wildcard answers ${answerList(a as string[] | undefined, labels)} → ${answerList(b as string[] | undefined, labels)}`,
        });
        break;
      case 'mutual_only': {
        const who = (value: unknown) => (value === false ? 'every request' : 'mutual requests');
        changes.push({ before: a, after: b, text: `Must covers ${who(a)} → ${who(b)}` });
        break;
      }
      case 'max_per_team': {
        const cap = (value: unknown) =>
          value === undefined ? 'nobody alone' : `at most ${value} per team`;
        changes.push({ before: a, after: b, text: `${cap(a)} → ${cap(b)}` });
        break;
      }
      case 'rule_a':
      case 'rule_b':
        changes.push({
          before: a,
          after: b,
          text: `rule ${key === 'rule_a' ? 'A' : 'B'} ${ruleRefText(a as string | undefined, labels)} → ${ruleRefText(b as string | undefined, labels)}`,
        });
        break;
      case 'answers': {
        const beforeMap = (a ?? {}) as Record<string, 'a' | 'b' | 'none'>;
        const afterMap = (b ?? {}) as Record<string, 'a' | 'b' | 'none'>;
        const answerKeys = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])];
        for (const answer of answerKeys) {
          const x = beforeMap[answer] ?? 'none';
          const y = afterMap[answer] ?? 'none';
          if (x === y) continue;
          changes.push({
            before: x,
            after: y,
            text: `${quoted(answerText(answer, labels))}: ${priorityEffect(x, before.params, labels)} → ${priorityEffect(y, after.params, labels)}`,
          });
        }
        break;
      }
      case 'shift':
        changes.push({ before: a, after: b, text: `shift ${a}% → ${b}%` });
        break;
      default:
        changes.push({ before: a, after: b, text: 'settings changed' });
    }
  }
  return changes;
}

function pinSame(a: TeamSetPin, b: TeamSetPin): boolean {
  const key = (pin: TeamSetPin) =>
    JSON.stringify([
      pin.kind,
      pinPeople(pin),
      pin.kind === 'on_option' ? pin.option_id : pin.kind === 'not_options' ? pin.option_ids : null,
      pin.reason ?? null,
    ]);
  return key(a) === key(b);
}

/**
 * What changed from `before` to `after`, compared on resolved values (an
 * unset non_respondents is its default; an option's size is its effective
 * bounds, listed only for options that set their own size on either side, so
 * a set-wide size change is one row). Listed in Setup's order: grouping, team
 * size, team count, people who didn't answer, fairness, options (in the
 * grouping question's order; skipped when the grouping question changed),
 * rules, pins (removed, then added), team names, GitHub teams, time limit.
 * Every `text` is a fixed template over labels and values.
 *
 * non_respondents is compared as each side says it. A run's snapshot always
 * says the mode it used; for the current setup the caller passes the mode a
 * run would use now (for pairs an unset setting depends on the count, which a
 * config alone doesn't say). A side left unset is read as its default when
 * Group can seat everyone (resolveNonRespondents).
 */
export function diffConfigs(
  before: TeamSetConfig,
  after: TeamSetConfig,
  labels: ExplainLabels
): SetupChange[] {
  const changes: SetupChange[] = [];

  // ── Grouping ──
  const g1 = before.grouping;
  const g2 = after.grouping;
  const sameQuestion =
    g1.mode === g2.mode &&
    (g1.mode === 'free' || (g2.mode === 'by_option' && g1.field_id === g2.field_id));
  if (!sameQuestion) {
    changes.push({
      kind: 'grouping',
      before: g1,
      after: g2,
      text: `Teams are made from: ${groupingText(g1, labels)} → ${groupingText(g2, labels)}`,
    });
  } else if (
    g1.mode === 'by_option' &&
    g2.mode === 'by_option' &&
    g1.teams_per_option !== g2.teams_per_option
  ) {
    changes.push({
      kind: 'grouping',
      before: g1.teams_per_option,
      after: g2.teams_per_option,
      text: `Teams per option: ${g1.teams_per_option} → ${g2.teams_per_option}`,
    });
  }

  // ── Team shape ──
  const s1 = before.team_size;
  const s2 = after.team_size;
  if (s1.min !== s2.min || s1.max !== s2.max) {
    changes.push({
      kind: 'team_size',
      before: { min: s1.min, max: s1.max },
      after: { min: s2.min, max: s2.max },
      text: `Team size: ${sizeText(s1)} → ${sizeText(s2)}`,
    });
  }
  if (countText(before.team_count) !== countText(after.team_count)) {
    changes.push({
      kind: 'team_count',
      before: before.team_count,
      after: after.team_count,
      text: `Number of teams: ${countText(before.team_count)} → ${countText(after.team_count)}`,
    });
  }
  const nr1 = resolveNonRespondents(before);
  const nr2 = resolveNonRespondents(after);
  if (nr1 !== nr2) {
    changes.push({
      kind: 'non_respondents',
      before: nr1,
      after: nr2,
      text: `People who didn't answer: ${NON_RESPONDENT_WORDS[nr1]} → ${NON_RESPONDENT_WORDS[nr2]}`,
    });
  }
  if (before.fairness !== after.fairness) {
    changes.push({
      kind: 'fairness',
      before: before.fairness,
      after: after.fairness,
      text: `Fairness: ${before.fairness} → ${after.fairness}`,
    });
  }

  // ── Options (only when both group by the same question) ──
  if (sameQuestion && g2.mode === 'by_option') {
    const ids = [
      ...[...labels.options.keys()].filter(id => id in before.options || id in after.options),
      ...[...new Set([...Object.keys(before.options), ...Object.keys(after.options)])]
        .filter(id => !labels.options.has(id))
        .sort(),
    ];
    for (const id of ids) {
      const o1 = before.options[id];
      const o2 = after.options[id];
      const name = capitalize(optionText(id, labels));
      const push = (
        field: 'open' | 'size' | 'note' | 'category' | 'team_name',
        a: unknown,
        b: unknown,
        text: string
      ) => changes.push({ kind: 'option', option_id: id, field, before: a, after: b, text });

      const open1 = o1?.open ?? 'auto';
      const open2 = o2?.open ?? 'auto';
      if (open1 !== open2)
        push('open', open1, open2, `${name}: ${OPEN_WORDS[open1]} → ${OPEN_WORDS[open2]}`);
      if (o1?.size || o2?.size) {
        const z1 = optionSize(before, id);
        const z2 = optionSize(after, id);
        if (z1.min !== z2.min || z1.max !== z2.max) {
          push('size', z1, z2, `${name} team size: ${sizeText(z1)} → ${sizeText(z2)}`);
        }
      }
      const n1 = o1?.note ?? null;
      const n2 = o2?.note ?? null;
      if (n1 !== n2) {
        const what = n1 === null ? 'note added' : n2 === null ? 'note removed' : 'note changed';
        push('note', n1, n2, `${name}: ${what}`);
      }
      const c1 = o1?.category ?? null;
      const c2 = o2?.category ?? null;
      if (c1 !== c2) {
        const cat = (value: string | null) => (value === null ? 'none' : quoted(value));
        push('category', c1, c2, `${name}: category ${cat(c1)} → ${cat(c2)}`);
      }
      const t1 = o1?.team_name ?? null;
      const t2 = o2?.team_name ?? null;
      if (t1 !== t2) {
        const tn = (value: string | null) => (value === null ? 'none' : quoted(value));
        push('team_name', t1, t2, `${name}: team name ${tn(t1)} → ${tn(t2)}`);
      }
    }
  }

  // ── Rules ──
  const beforeRules = new Map(before.rules.map(rule => [teamSetRuleId(rule), rule]));
  const afterIds = new Set(after.rules.map(rule => teamSetRuleId(rule)));
  const head = (rule: TeamSetRule) =>
    `${questionText(rule.field_id, labels)} (${TEAM_SET_JOB_WORDS[rule.job]})`;
  const ruleChange = (
    rule: TeamSetRule,
    change: 'added' | 'removed' | 'strength' | 'weight' | 'params',
    a: unknown,
    b: unknown,
    text: string
  ) =>
    changes.push({
      kind: 'rule',
      field_id: rule.field_id,
      job: rule.job,
      change,
      before: a,
      after: b,
      text,
    });

  for (const rule of after.rules) {
    const old = beforeRules.get(teamSetRuleId(rule));
    if (!old) {
      ruleChange(rule, 'added', null, rule, `${head(rule)} added: ${strengthText(rule)}`);
      continue;
    }
    if (old.strength !== rule.strength) {
      ruleChange(
        rule,
        'strength',
        old.strength,
        rule.strength,
        `${head(rule)}: ${strengthText(old)} → ${strengthText(rule)}`
      );
    } else if (old.weight !== rule.weight && !WEIGHTLESS_JOBS.includes(rule.job)) {
      ruleChange(
        rule,
        'weight',
        old.weight,
        rule.weight,
        `${head(rule)}: weight ${old.weight} → ${rule.weight}`
      );
    }
    for (const param of paramChanges(old, rule, labels)) {
      ruleChange(rule, 'params', param.before, param.after, `${head(rule)}: ${param.text}`);
    }
  }
  for (const rule of before.rules) {
    if (afterIds.has(teamSetRuleId(rule))) continue;
    ruleChange(rule, 'removed', rule, null, `${head(rule)} removed`);
  }

  // ── Pins (by id; an id whose pin differs is removed and added) ──
  const afterPins = new Map(after.pins.map(pin => [pin.id, pin]));
  const beforePins = new Map(before.pins.map(pin => [pin.id, pin]));
  for (const pin of before.pins) {
    const kept = afterPins.get(pin.id);
    if (kept && pinSame(pin, kept)) continue;
    changes.push({
      kind: 'pin',
      pin_id: pin.id,
      change: 'removed',
      pin: toPinView(pin, labels),
      text: `Pin removed: ${pinPhrase(pin, labels)}`,
    });
  }
  for (const pin of after.pins) {
    const had = beforePins.get(pin.id);
    if (had && pinSame(had, pin)) continue;
    changes.push({
      kind: 'pin',
      pin_id: pin.id,
      change: 'added',
      pin: toPinView(pin, labels),
      text: `Pin added: ${pinPhrase(pin, labels)}`,
    });
  }

  // ── Create and engine settings ──
  if (before.team_name_template !== after.team_name_template) {
    changes.push({
      kind: 'team_name_template',
      before: before.team_name_template,
      after: after.team_name_template,
      text: `Team names: ${before.team_name_template} → ${after.team_name_template}`,
    });
  }
  if (before.github_teams !== after.github_teams) {
    const word = (on: boolean) => (on ? 'yes' : 'no');
    changes.push({
      kind: 'github_teams',
      before: before.github_teams,
      after: after.github_teams,
      text: `Also create GitHub teams: ${word(before.github_teams)} → ${word(after.github_teams)}`,
    });
  }
  if (before.time_limit_s !== after.time_limit_s) {
    changes.push({
      kind: 'time_limit_s',
      before: before.time_limit_s,
      after: after.time_limit_s,
      text: `Time limit: ${before.time_limit_s} → ${after.time_limit_s}`,
    });
  }
  return changes;
}

// ════════════════════════════════════════════════════════════════════════════
// Compare two runs
// ════════════════════════════════════════════════════════════════════════════

function top3(metrics: TeamSetMetrics | null): number | null {
  if (!metrics) return null;
  return metrics.top3 ?? metrics.placement['1'] + metrics.placement['2'] + metrics.placement['3'];
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

function openOptionIds(run: ExplainRun, ix: RunIndex): Set<string> {
  const ids = new Set<string>();
  ix.teams.forEach((team, t) => {
    const id = teamOption(run, ix, t);
    if (id !== null && team.member_user_ids.length > 0) ids.add(id);
  });
  return ids;
}

/**
 * `run` compared with `other` (usually the run before it): the setup changes
 * from other's config to run's, the metric rows (delta = run − other; the
 * pick rows only when both runs group by a question — free teams have no
 * picks), and who moved — a person in both runs whose option changed (free
 * mode, when either run is free, or with `byTeammates`: whose teammates
 * changed) — with only pin and request facts: the pin in run's setup that
 * names them (one added since `other` first) and each together request
 * involving them whose kept state flipped.
 */
export function compareAssignments(
  run: ExplainRun,
  other: ExplainRun,
  labels: ExplainLabels,
  opts: { byTeammates?: boolean } = {}
): RunComparison {
  const ix = indexRun(run);
  const ox = indexRun(other);
  const m = run.metrics;
  const o = other.metrics;

  const metrics: CompareMetricRow[] = [];
  const row = (
    key: CompareMetricKey,
    a: number | null,
    b: number | null,
    extra: Partial<CompareMetricRow> = {}
  ) => metrics.push({ key, run: a, other: b, delta: delta(a, b), ...extra });
  if (run.config.grouping.mode === 'by_option' && other.config.grouping.mode === 'by_option') {
    row('first_choice', m?.first_choice ?? null, o?.first_choice ?? null);
    row('top3', top3(m), top3(o));
  }
  row('requests_kept', m?.requests.kept ?? null, o?.requests.kept ?? null, {
    of: { run: m?.requests.total ?? null, other: o?.requests.total ?? null },
  });
  row('must_broken', m?.must_broken ?? null, o?.must_broken ?? null);
  const grouped =
    run.config.grouping.mode === 'by_option' || other.config.grouping.mode === 'by_option';
  if (grouped) {
    const both = run.result !== null && other.result !== null;
    const mine = openOptionIds(run, ix);
    const theirs = openOptionIds(other, ox);
    row('options_open', m?.options_open ?? null, o?.options_open ?? null, {
      of: { run: m?.options_total ?? null, other: o?.options_total ?? null },
      ...(both
        ? { same_set: mine.size === theirs.size && [...mine].every(id => theirs.has(id)) }
        : {}),
    });
  }
  const ruleIds = [
    ...new Set([
      ...(m?.rules ?? []).map(rule => rule.rule_id),
      ...(o?.rules ?? []).map(rule => rule.rule_id),
    ]),
  ];
  for (const ruleId of ruleIds) {
    const a = m?.rules?.find(rule => rule.rule_id === ruleId);
    const b = o?.rules?.find(rule => rule.rule_id === ruleId);
    row('rule_held', a?.teams_held ?? null, b?.teams_held ?? null, {
      rule_id: ruleId,
      identity: a?.identity ?? b?.identity ?? false,
      of: { run: a?.teams_total ?? null, other: b?.teams_total ?? null },
    });
  }

  // ── People ──
  const byTeammates = ix.free || ox.free || opts.byTeammates === true;
  const seat = (r: ExplainRun, x: RunIndex, userId: string): RunSeat => {
    const t = x.teamOf.get(userId)!;
    const optionId = teamOption(r, x, t);
    return {
      option: optionId === null ? null : optionRef(optionId, labels),
      team_n: t + 1,
      rank: x.free ? null : rankOf(x.person.get(userId), optionId),
    };
  };
  const mates = (x: RunIndex, userId: string) =>
    x.teams[x.teamOf.get(userId)!]!.member_user_ids.filter(id => id !== userId);
  const together = (x: RunIndex, a: string, b: string) => {
    const t = x.teamOf.get(a);
    return t !== undefined && t === x.teamOf.get(b);
  };
  const asks = (x: RunIndex, userId: string) => new Set(x.person.get(userId)?.requests ?? []);

  let unchanged = 0;
  let joined = 0;
  const moved: RunMover[] = [];
  for (const userId of ix.teamOf.keys()) {
    if (!ox.teamOf.has(userId)) {
      joined += 1;
      continue;
    }
    const from = seat(other, ox, userId);
    const to = seat(run, ix, userId);
    const changed = byTeammates
      ? !sameMembers(mates(ix, userId), mates(ox, userId))
      : from.option?.id !== to.option?.id;
    if (!changed) {
      unchanged += 1;
      continue;
    }
    const pins = run.config.pins.filter(pin => pinPeople(pin).includes(userId));
    const pin =
      pins.find(
        candidate =>
          !other.config.pins.some(old => old.id === candidate.id && pinSame(old, candidate))
      ) ?? pins[0];

    const requests: RunMover['requests'] = [];
    const flip = (asker: string, asked: string) => {
      if (!asks(ix, asker).has(asked) || !asks(ox, asker).has(asked)) return;
      const now = together(ix, asker, asked);
      const then = together(ox, asker, asked);
      if (now === then) return;
      requests.push({
        kind: now ? 'now_kept' : 'no_longer_kept',
        asker: personRef(asker, labels.names),
        asked: personRef(asked, labels.names),
      });
    };
    for (const asked of asks(ix, userId)) flip(userId, asked);
    for (const person of run.context.people) {
      if (person.user_id !== userId && person.requests.includes(userId))
        flip(person.user_id, userId);
    }

    moved.push({
      user: personRef(userId, labels.names),
      from,
      to,
      ...(pin ? { pin: { pin_id: pin.id, kind: pin.kind, reason: pin.reason ?? null } } : {}),
      requests,
    });
  }
  let left = 0;
  for (const userId of ox.teamOf.keys()) if (!ix.teamOf.has(userId)) left += 1;
  moved.sort((a, b) => byName(a.user, b.user));

  return {
    run_number: run.number,
    other_run_number: other.number,
    changes: diffConfigs(other.config, run.config, labels),
    metrics,
    moved,
    unchanged,
    joined,
    left,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Closed provenance
// ════════════════════════════════════════════════════════════════════════════

type OptionSettings = TeamSetConfig['options'][string];

/**
 * The option was closed by the same act in both settings: equal when both
 * carry a closed_at stamp, else assumed (configs saved before stamps).
 */
function sameClosing(a: OptionSettings | undefined, b: OptionSettings | undefined): boolean {
  if (a?.closed_at !== undefined && b?.closed_at !== undefined) {
    return a.closed_at === b.closed_at && a.closed_by === b.closed_by;
  }
  return true;
}

/**
 * Since when each Closed option has been closed, and by whom.
 *
 * With `upToRun`: the options closed in that run's snapshot. `since_run` is
 * the first run of the unbroken streak of runs (numbered up to `upToRun`)
 * whose snapshots have it closed by the same act — a closed_at stamp that
 * differs between two snapshots means it was reopened and closed again in
 * between, which ends the streak. Without `upToRun`: the options closed in
 * `current` (the setup now); when the latest run has it closed by the same
 * act, the streak is walked from there, else it was closed after the last
 * run (`since_run` null).
 *
 * `by`/`via` come from the stamp in the snapshot the streak starts at (or
 * `current`'s for since_run null). Only a config saved before stamps existed
 * falls back to that run's `created_by` (via null).
 */
export function closedProvenance(
  runs: readonly { number: number; config: TeamSetConfig; created_by: string }[],
  current: TeamSetConfig | null,
  upToRun?: number
): Map<string, ClosedProvenance> {
  const out = new Map<string, ClosedProvenance>();
  const sorted = [...runs].sort((a, b) => a.number - b.number);
  let target: TeamSetConfig | null;
  let history: typeof sorted;
  if (upToRun !== undefined) {
    const run = sorted.find(entry => entry.number === upToRun);
    if (!run) return out;
    target = run.config;
    history = sorted.filter(entry => entry.number <= upToRun);
  } else {
    target = current;
    history = sorted;
  }
  if (!target) return out;

  for (const [optionId, settings] of Object.entries(target.options)) {
    if (settings.open !== 'closed') continue;
    let i = history.length - 1;
    const last = history[i];
    const lastSettings = last?.config.options[optionId];
    const inLast =
      last !== undefined &&
      lastSettings?.open === 'closed' &&
      (upToRun !== undefined || sameClosing(lastSettings, settings));
    if (!inLast) {
      out.set(optionId, {
        since_run: null,
        by: settings.closed_by ?? null,
        via: settings.closed_by ? (settings.closed_via ?? null) : null,
      });
      continue;
    }
    while (i > 0) {
      const earlier = history[i - 1]!.config.options[optionId];
      if (earlier?.open !== 'closed' || !sameClosing(earlier, history[i]!.config.options[optionId]))
        break;
      i -= 1;
    }
    const start = history[i]!;
    const stamp = start.config.options[optionId];
    out.set(optionId, {
      since_run: start.number,
      by: stamp?.closed_by ?? start.created_by,
      via: stamp?.closed_by ? (stamp.closed_via ?? null) : null,
    });
  }
  return out;
}
