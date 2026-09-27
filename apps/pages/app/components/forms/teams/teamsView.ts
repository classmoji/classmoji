/**
 * Team sets page — the fixed templates every Teams screen fills with facts.
 *
 * Every string a Teams component shows that is not a name, a label, or text a
 * person typed comes from here, so the rules hold in one place and one spec
 * (`tests/unit/teams-view.spec.ts`) can read them all:
 *   - facts only: counts, labels, names, typed text; no causes, no advice,
 *     no counterfactuals, no timing;
 *   - nothing is appended after typed text (a pin reason, an option note):
 *     it is joined with ": " or " · " so a reason that ends in a full stop
 *     doesn't get a second one;
 *   - a person without a name is UNNAMED everywhere, possessives included;
 *   - dates arrive already formatted (components format after mount).
 *
 * Must labels are NOT templated here: they come from the service's
 * `ruleMustLabel` (on `SetupQuestion.must_labels`, or called directly), the one
 * template source the MCP tools share.
 *
 * PURE: values only from the browser-safe `@classmoji/services/team-set-*`
 * subpaths. The poll predicates live here, not in the hook, so they are
 * testable without React Router.
 */

import type {
  ClosedProvenanceView,
  CompareMetricKey,
  CompareMetricRow,
  CoreItem,
  CreateProgressView,
  CreateTeamProgress,
  NonRespondentsMode,
  OptionRef,
  OptionStatus,
  PersonRef,
  PinView,
  PlacementFacts,
  PriorityFact,
  RunComparison,
  RunMover,
  RunSeat,
  SetupChange,
  TeamSetStatus,
  TeamSignals,
} from '@classmoji/services/team-set-explain';
import {
  DEFAULT_PRIORITY_SHIFT,
  DEFAULT_RANK_COSTS,
  DEFAULT_UNRANKED_COST,
  type TeamSetJob,
  type TeamSetPriorityAnswer,
} from '@classmoji/services/team-set-config';
import type { TeamSetMetrics, TeamSetPlacement } from '@classmoji/services/team-set-metrics';
import type { TeamSetSolveStatus } from '@classmoji/services/team-set-problem';

import { createFailureSentence, teamsErrorSentence } from './teamsErrors.ts';
import type {
  AnswerCount,
  CheckLine,
  CreateAvailability,
  CreatePollView,
  CreatePreviewView,
  IdentityRuleView,
  PinTargetOption,
  QuestionCounts,
  QuestionTypeFacts,
  RunProgress,
  RunSolverView,
  SetStatusPayload,
  SetupOption,
  SetupQuestion,
  SetupView,
  TeamSetLayoutData,
  TeamSetListRow,
  TeamSetPaths,
  TeamSetRule,
  TeamSetRunStatus,
  TeamSetStrength,
} from './types.ts';

export { ruleMustLabel } from '@classmoji/services/team-set-explain';

// ─── Words and numbers ──────────────────────────────────────────────────────

/** What a person without a name is called. */
export const UNNAMED = 'Unnamed person';

/** What an option no longer on the form is called. */
export const GONE_OPTION = 'An option no longer on the form';

/** `1 team`, `2 teams`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 102nd. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** A multiplier as the why panel prints it: 1.5, 0.3, 1 (two places at most, no trailing zeros). */
export function formatFactor(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** An average: one decimal (3.2, 4.0). */
export function formatAverage(value: number): string {
  return value.toFixed(1);
}

/** Quoted text a person typed (or an option label the form holds). */
export function quoted(value: string): string {
  return `"${value}"`;
}

/** A size range: "4–6", or "4" when min = max. */
export function sizeText(size: { min: number; max: number }): string {
  return size.min === size.max ? String(size.min) : `${size.min}–${size.max}`;
}

// ─── People ─────────────────────────────────────────────────────────────────

export function personName(person: PersonRef | null | undefined): string {
  return person?.name ?? UNNAMED;
}

/** "You" (or "you") for the viewer, else the person's name. */
export function whoText(person: PersonRef, viewerId: string, capital = false): string {
  if (person.user_id === viewerId) return capital ? 'You' : 'you';
  return personName(person);
}

/** "Unnamed person's", "Mira's". */
function possessive(person: PersonRef): string {
  return `${personName(person)}'s`;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** An option's label, or GONE_OPTION when it has none. */
export function optionLabel(option: OptionRef | null | undefined): string {
  return option?.label ?? GONE_OPTION;
}

/**
 * How a run left an option: "full, 4 of 4", "running, 5 of 6", "not running",
 * "closed"; "full" / "running" alone when the counts aren't given, '' when
 * the status isn't (a view that doesn't show how options ran).
 */
export function optionStatusText(
  status:
    | (Partial<Pick<OptionStatus, 'placed' | 'max'>> & {
        status?: OptionStatus['status'] | null;
      })
    | null
    | undefined
): string {
  const counts =
    typeof status?.placed === 'number' && typeof status.max === 'number'
      ? `, ${status.placed} of ${status.max}`
      : '';
  switch (status?.status) {
    case 'closed':
      return 'closed';
    case 'not_running':
      return 'not running';
    case 'full':
      return `full${counts}`;
    case 'running':
      return `running${counts}`;
    case 'not_on_form':
      return 'no longer on the form';
    default:
      return '';
  }
}

/** Setup's three-way "Runs" control. */
export const OPTION_RUNS_LABELS: Readonly<Record<SetupOption['runs'], string>> = {
  auto: 'Solver decides',
  open: 'Always',
  closed: 'Closed',
};

/** "Pantry always runs and Roost is closed; the solver decides on the other 6." */
export function optionRunsSummary(options: readonly Pick<SetupOption, 'label' | 'runs'>[]): string {
  const always = options.filter(option => option.runs === 'open').map(option => option.label);
  const closed = options.filter(option => option.runs === 'closed').map(option => option.label);
  const auto = options.length - always.length - closed.length;
  const parts: string[] = [];
  if (always.length)
    parts.push(`${listJoin(always)} always ${always.length === 1 ? 'runs' : 'run'}`);
  if (closed.length) parts.push(`${listJoin(closed)} ${closed.length === 1 ? 'is' : 'are'} closed`);
  if (parts.length === 0) return `The solver decides on all ${auto}.`;
  const fixed = parts.join(' and ');
  if (auto === 0) return `${fixed}.`;
  return `${fixed}; the solver decides on the other ${auto}.`;
}

/** Projects table "Wanted 1st · top 3". */
export function wantedText(wanted: SetupOption['wanted']): string {
  return `${wanted.first} · ${wanted.top3}`;
}

/** Projects table "Pitcher": names, "Not on the roster" for an answer from off the roster, "None". */
export function pitchersText(pitchers: SetupOption['pitchers']): string {
  if (pitchers.length === 0) return 'None';
  return pitchers
    .map(pitcher => (pitcher.on_roster ? (pitcher.name ?? UNNAMED) : 'Not on the roster'))
    .join(', ');
}

/** A Projects table "Pinned here" chip: "Ana Ruiz: has a badge" (the name alone without a reason). */
export function pinnedHereText(pinned: { name: string | null; reason: string | null }): string {
  const name = pinned.name ?? UNNAMED;
  return pinned.reason ? `${name}: ${pinned.reason}` : name;
}

/** Pin block's "Move to" choices: an option no team was opened on says so. */
export function pinTargetLabel(option: PinTargetOption): string {
  return option.running ? option.label : `${option.label} (not running)`;
}

// ─── Set and run status ─────────────────────────────────────────────────────

export const SET_STATUS_LABELS: Readonly<Record<TeamSetStatus, string>> = {
  setting_up: 'Setting up',
  creating: 'Creating teams',
  created: 'Created',
  partial: 'Created in part',
  create_failed: 'Create failed',
};

/** "Run 5 running", "Run 5 queued": a run that hasn't finished. */
export function runActiveText(run: { number: number; status: 'QUEUED' | 'RUNNING' }): string {
  return `${runTitle(run.number)} ${run.status === 'QUEUED' ? 'queued' : 'running'}`;
}

/** What the status chip is filled with; each fact is left out when it isn't known. */
export interface SetStatusChipFacts {
  runCount: number;
  /** The set's latest run while it is QUEUED or RUNNING. */
  activeRun?: { number: number; status: 'QUEUED' | 'RUNNING' } | null;
  /** The create's progress: teams finished of teams in it. */
  creating?: { done: number; total: number } | null;
  /** The run the create is from. */
  createRun?: number | null;
  /** The create's finish date, formatted by the caller. */
  createdOn?: string | null;
}

/**
 * The status chip: "Setting up · 4 runs", "Setting up · Run 5 running",
 * "Creating teams · 3 of 5", "Created 12 Sep · from run 4", "Create failed ·
 * from run 4" (the date formatted by the caller).
 */
export function setStatusChipText(status: TeamSetStatus, facts: SetStatusChipFacts): string {
  const label = SET_STATUS_LABELS[status];
  const fromRun = facts.createRun ? `from run ${facts.createRun}` : null;
  switch (status) {
    case 'setting_up':
      if (facts.activeRun) return `${label} · ${runActiveText(facts.activeRun)}`;
      return facts.runCount > 0 ? `${label} · ${plural(facts.runCount, 'run')}` : label;
    case 'creating':
      return facts.creating && facts.creating.total > 0
        ? `${label} · ${facts.creating.done} of ${facts.creating.total}`
        : label;
    case 'created':
    case 'partial': {
      const head = facts.createdOn ? `${label} ${facts.createdOn}` : label;
      return fromRun ? `${head} · ${fromRun}` : head;
    }
    case 'create_failed':
      return fromRun ? `${label} · ${fromRun}` : label;
  }
}

/** The status chip's colours, on the sets list and in the set header. */
export const SET_STATUS_TONES: Readonly<Record<TeamSetStatus, string>> = {
  setting_up:
    'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200',
  creating:
    'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200',
  created:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  partial:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  create_failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
};

/** The sets list's fact line for an unpublished CLASSROOM form. */
export const FORM_NOT_PUBLISHED_TEXT = "This form isn't published.";

/** The empty list's second line: "This form has 21 submitted responses." */
export function listEmptyText(responses: number): string {
  return `This form has ${plural(responses, 'submitted response')}.`;
}

export const RUN_STATUS_LABELS: Readonly<Record<TeamSetRunStatus, string>> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  SOLVED: 'Solved',
  INFEASIBLE: 'Not solved',
  FAILED: 'Failed',
  CANCELED: 'Canceled',
};

export function runTitle(number: number): string {
  return `Run ${number}`;
}

/** Running card's link to the last solved run: "Show run 4". */
export function showRunText(number: number): string {
  return `Show run ${number}`;
}

/** Compare's links: "Back to run 4", "Open run 3". */
export function backToRunText(number: number): string {
  return `Back to run ${number}`;
}

export function openRunText(number: number): string {
  return `Open run ${number}`;
}

/**
 * The runline chip for a stale run, no full stop: "1 response changed since
 * this run", "3 responses changed since this run"; without a count (a run
 * view carries only the reasons, which may be the roster or a republish),
 * "Answers or the roster changed since this run". The reasons list the chip
 * opens comes from the run.
 */
export function staleChipText(count?: number | null): string {
  if (count === undefined || count === null) return 'Answers or the roster changed since this run';
  return `${plural(count, 'response')} changed since this run`;
}

/** "16 of 21 got their 1st pick". */
export function firstPickText(first: number, responded: number): string {
  return `${first} of ${responded} got their 1st pick`;
}

/** The run rail's headline: "16/21 1st picks". */
export function firstPicksShort(first: number, responded: number): string {
  return `${first}/${responded} 1st picks`;
}

/**
 * Whether a run's pick counts are shown: a solved run whose own setup made
 * its teams from a question, with both counts there. A run with no grouping
 * question (free teams) has no picks, whatever its metrics hold.
 */
export function showsPicks(run: {
  status: TeamSetRunStatus;
  grouped?: boolean;
  first_choice?: number | null;
  responded?: number | null;
}): run is typeof run & { first_choice: number; responded: number } {
  return (
    run.status === 'SOLVED' &&
    run.grouped === true &&
    typeof run.first_choice === 'number' &&
    typeof run.responded === 'number'
  );
}

/** The list's "Latest run" cell: its 1st picks once solved (grouped runs), else its status. */
export function listLatestRunText(row: Pick<TeamSetListRow, 'latest_run' | 'created'>): string {
  if (row.created) {
    return `${runTitle(row.created.run_number)} · ${plural(row.created.teams_created, 'team')} created`;
  }
  const run = row.latest_run;
  if (!run) return 'No runs yet';
  if (showsPicks(run)) {
    return `${runTitle(run.number)} · ${firstPickText(run.first_choice, run.responded)}`;
  }
  return `${runTitle(run.number)} · ${RUN_STATUS_LABELS[run.status]}`;
}

/** A gap as "within x% of best" states it: one decimal, rounded up so the bound stays true. */
export function gapText(gapPct: number): string {
  const up = Math.ceil(gapPct * 10) / 10;
  return String(Number(up.toFixed(1)));
}

/** "proven best", "within 2.4% of best", "not proven best"; null when not solved. */
export function solverLabel(
  solver: Pick<RunSolverView, 'status' | 'gap_pct'> | null | undefined
): string | null {
  if (!solver) return null;
  const status: TeamSetSolveStatus = solver.status;
  if (status === 'OPTIMAL' || (status === 'FEASIBLE' && solver.gap_pct === 0)) return 'proven best';
  if (status === 'FEASIBLE') {
    return solver.gap_pct !== null && solver.gap_pct > 0
      ? `within ${gapText(solver.gap_pct)}% of best`
      : 'not proven best';
  }
  return null;
}

/** The runline title: "Run 4 · proven best", "Run 6 · not solved", "Run 5". */
export function runlineText(
  number: number,
  status: TeamSetRunStatus,
  solver: Pick<RunSolverView, 'status' | 'gap_pct'> | null | undefined
): string {
  if (status === 'INFEASIBLE') return `${runTitle(number)} · not solved`;
  const label = status === 'SOLVED' ? solverLabel(solver) : null;
  return label ? `${runTitle(number)} · ${label}` : runTitle(number);
}

// ─── Poll ───────────────────────────────────────────────────────────────────

const TERMINAL_RUN_STATUSES: ReadonlySet<TeamSetRunStatus> = new Set([
  'SOLVED',
  'INFEASIBLE',
  'FAILED',
  'CANCELED',
]);

/** QUEUED or RUNNING. */
export function isRunActive(status: TeamSetRunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

export function isCreateRunning(create: Pick<CreateProgressView, 'status'> | null): boolean {
  return create?.status === 'RUNNING';
}

/** Nothing is moving: no unfinished run and no create in progress. */
export function statusSettled(payload: Pick<SetStatusPayload, 'latest_run' | 'create'>): boolean {
  const runActive = payload.latest_run !== null && isRunActive(payload.latest_run.status);
  return !runActive && !isCreateRunning(payload.create);
}

/**
 * A create as a page loaded it, with the status poll's latest answer over it:
 * the status, the counts, and each row's state by its position in the run.
 * The names — the teams', who claimed it, who wasn't added, renames — stay as
 * loaded (the poll carries none) until the next page load brings new ones.
 * `loaded` as it is before the first answer, or when the answer is about a
 * create from another run.
 */
export function liveCreate(
  loaded: CreateProgressView,
  live: CreatePollView | null
): CreateProgressView {
  if (!live || live.run_number !== loaded.run_number) return loaded;
  const states = new Map(live.teams.map(team => [team.n, team]));
  return {
    ...loaded,
    status: live.status,
    attempt: live.attempt,
    total: live.total,
    done: live.done,
    counts: live.counts,
    members_total: live.members_total,
    finished_at: live.finished_at,
    teams: loaded.teams.map(team => {
      const now = states.get(team.n);
      return now ? { ...now, name: team.name } : team;
    }),
  };
}

/**
 * Whether the set's create leads its pages: Setup opens on its card (or the
 * Created summary) and the Runs tab opens its run. A running or finished
 * create always does. A FAILED one does while the set is locked (teams were
 * made from it; Retry is the way on), and otherwise until a run is solved
 * after it finished — by finish times, not run numbers, so a failed create
 * from an older run leads too. From then on the failure shows on its own
 * run's page only, and Runs opens the latest run.
 */
export function createLeadsSet<
  C extends Pick<CreateProgressView, 'status' | 'started_at' | 'finished_at'>,
>(create: C | null, facts: { locked: boolean; latestSolvedAt: string | null }): create is C {
  if (!create) return false;
  if (create.status !== 'FAILED' || facts.locked) return true;
  const solvedAt = facts.latestSolvedAt ? Date.parse(facts.latestSolvedAt) : NaN;
  const failedAt = Date.parse(create.finished_at ?? create.started_at);
  if (Number.isNaN(solvedAt) || Number.isNaN(failedAt)) return true;
  return solvedAt <= failedAt;
}

/**
 * The status the set's chip shows. A create that failed without making a team
 * leaves the set free to run again, so while a run is QUEUED or RUNNING the
 * chip shows that run ("Setting up · Run 5 running"); the failure stays on its
 * own run's page. Every other status is shown as it is.
 */
export function shownSetStatus(
  status: TeamSetStatus,
  facts: { locked: boolean; activeRun?: { number: number } | null }
): TeamSetStatus {
  return status === 'create_failed' && !facts.locked && facts.activeRun ? 'setting_up' : status;
}

/** Whether the set pages should poll, from the layout's data. */
export function layoutPollActive(
  layout: Pick<TeamSetLayoutData, 'activeRun' | 'latestRun' | 'create'>
): boolean {
  return (
    layout.activeRun !== null ||
    (layout.latestRun !== null && isRunActive(layout.latestRun.status)) ||
    isCreateRunning(layout.create)
  );
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** The form's team sets list: `/{class}/forms/{form}/teams`. */
export function teamSetsListPath(classroomSlug: string, formSlug: string): string {
  return `/${classroomSlug}/forms/${formSlug}/teams`;
}

/**
 * Every URL of one set. Slugs are URL-safe already (as FormAdminTabs builds
 * them); a set's name is typed, so it is encoded.
 */
export function teamSetPaths(facts: {
  classroomSlug: string;
  formSlug: string;
  setName: string;
}): TeamSetPaths {
  const list = teamSetsListPath(facts.classroomSlug, facts.formSlug);
  const set = `${list}/${encodeURIComponent(facts.setName)}`;
  return { list, set, runs: `${set}/runs`, status: `${set}/status` };
}

export function runPath(paths: Pick<TeamSetPaths, 'runs'>, number: number): string {
  return `${paths.runs}/${number}`;
}

export function comparePath(
  paths: Pick<TeamSetPaths, 'runs'>,
  number: number,
  other: number
): string {
  return `${paths.runs}/${number}/compare/${other}`;
}

// ─── Setup rows and Can't solve links ───────────────────────────────────────

/**
 * The element ids of Setup's rows, which Can't solve deep-links to
 * (`#q-…`, `#opt-…`, `#pin-…`, `#nr`, `#shape`). Setup components use these
 * and nothing else, so the two screens can't drift apart.
 */
export const SETUP_ROW_IDS = {
  question: (fieldId: string) => `q-${fieldId}`,
  option: (optionId: string) => `opt-${optionId}`,
  pin: (pinId: string) => `pin-${pinId}`,
  nonRespondents: 'nr',
  teamShape: 'shape',
  questions: 'questions',
  projects: 'projects',
  pins: 'pins',
  checks: 'checks',
} as const;

/** The Setup row a Can't-solve item points at; null when it points nowhere. */
export function setupRowId(link: CoreItem['link']): string | null {
  switch (link.tab) {
    case 'questions':
      return link.field_id ? SETUP_ROW_IDS.question(link.field_id) : SETUP_ROW_IDS.questions;
    case 'projects':
      return link.option_id ? SETUP_ROW_IDS.option(link.option_id) : SETUP_ROW_IDS.projects;
    case 'pins':
      return link.pin_id ? SETUP_ROW_IDS.pin(link.pin_id) : SETUP_ROW_IDS.pins;
    case 'non_respondents':
      return SETUP_ROW_IDS.nonRespondents;
    case 'team_shape':
      return SETUP_ROW_IDS.teamShape;
    default:
      return null;
  }
}

/** "#opt-…" for a Link's `hash`; null when the item points nowhere. */
export function coreLinkHash(link: CoreItem['link']): string | null {
  const id = setupRowId(link);
  return id ? `#${id}` : null;
}

/** The link's text: "Change in Projects". */
export function coreLinkLabel(link: CoreItem['link']): string | null {
  switch (link.tab) {
    case 'questions':
      return 'Change in Questions';
    case 'projects':
      return 'Change in Projects';
    case 'pins':
      return 'Change in Pins';
    case 'team_shape':
      return 'Change in Team shape';
    case 'non_respondents':
      return "Change in People who didn't answer";
    default:
      return null;
  }
}

// ─── Closed provenance ──────────────────────────────────────────────────────

/**
 * "You closed it before run 6", "Ana Ruiz closed it before run 1 · over MCP",
 * "Closed before run 3" (no one recorded), "You closed it after the last run"
 * (since_run null: closed after the latest run).
 */
export function closedProvenanceText(closed: ClosedProvenanceView, viewerId: string): string {
  const who = closed.by ? whoText(closed.by, viewerId, true) : null;
  const when = closed.since_run !== null ? `before run ${closed.since_run}` : 'after the last run';
  const line = who ? `${who} closed it ${when}` : `Closed ${when}`;
  return closed.via === 'mcp' ? `${line} · over MCP` : line;
}

// ─── Pins ───────────────────────────────────────────────────────────────────

export const PIN_KIND_LABELS: Readonly<Record<PinView['kind'], string>> = {
  on_option: 'On',
  not_options: 'Not on',
  together: 'Together',
  apart: 'Apart',
};

/**
 * Who added a pin: "you", "Ana Ruiz", "you · over MCP", "over MCP"; null
 * when the pin predates the stamps.
 */
export function pinAttribution(
  pin: Pick<PinView, 'added_by' | 'added_via'>,
  viewerId: string
): string | null {
  const who = pin.added_by ? whoText(pin.added_by, viewerId) : null;
  if (pin.added_via === 'mcp') return who ? `${who} · over MCP` : 'over MCP';
  return who;
}

/** The Pins card's people part: "Theo Brandt → Trailhead", "Ines Moreau + Omar Farouk", "Caleb Stone · Pulse". */
export function pinPeopleText(
  pin: Pick<PinView, 'kind' | 'people' | 'option' | 'options'>
): string {
  const names = pin.people.map(personName);
  switch (pin.kind) {
    case 'on_option':
      return `${names[0] ?? UNNAMED} → ${optionLabel(pin.option)}`;
    case 'not_options':
      return `${names[0] ?? UNNAMED} · ${(pin.options ?? []).map(optionLabel).join(', ')}`;
    case 'together':
    case 'apart':
      return names.join(' + ');
  }
}

/** The Pins card's second part: the reason, then who added it ("Has a badge · you"). */
export function pinDetailText(
  pin: Pick<PinView, 'reason' | 'added_by' | 'added_via'>,
  viewerId: string
): string {
  return [pin.reason, pinAttribution(pin, viewerId)].filter(Boolean).join(' · ');
}

// ─── Setup ──────────────────────────────────────────────────────────────────

/** Readiness strip, less the close time (formatted after mount): "24 on the roster", "21 answered", "3 haven't". */
export function readinessParts(readiness: SetupView['readiness']): string[] {
  return [
    `${readiness.roster} on the roster`,
    `${readiness.answered} answered`,
    `${readiness.not_answered} haven't`,
  ];
}

/** "Form closes Fri 5:00 pm" / "Form closed Fri 5:00 pm". */
export function formCloseText(closed: boolean, localTime: string): string {
  return `Form ${closed ? 'closed' : 'closes'} ${localTime}`;
}

/** A question's type facts after its type name: "8 options · top 5", "1–5", "optional", "roster". */
export function typeFactsText(facts: QuestionTypeFacts): string {
  const parts: string[] = [];
  if (facts.options !== undefined) parts.push(plural(facts.options, 'option'));
  if (facts.ranks !== undefined) parts.push(`top ${facts.ranks}`);
  if (facts.min !== undefined && facts.max !== undefined) {
    parts.push(sizeText({ min: facts.min, max: facts.max }));
  }
  if (facts.source === 'roster') parts.push('roster');
  if (facts.source === 'teaching_team') parts.push('teaching team');
  if (facts.required === false) parts.push('optional');
  return parts.join(' · ');
}

/** A question's counts: "12 requests · 4 mutual", "3 pitchers", "Class average 3.2", "19 answered · 2 skipped". */
export function questionCountsText(counts: QuestionCounts): string {
  if (counts.requests !== undefined) {
    const parts = [plural(counts.requests, 'request')];
    if (counts.mutual !== undefined) parts.push(`${counts.mutual} mutual`);
    return parts.join(' · ');
  }
  if (counts.pitchers !== undefined) return plural(counts.pitchers, 'pitcher');
  if (counts.class_average !== undefined && counts.class_average !== null) {
    return `Class average ${formatAverage(counts.class_average)}`;
  }
  const parts = [`${counts.answered} answered`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(' · ');
}

/** The Must sentence for a job on a question (from ruleMustLabel via the loader); null = no Must. */
export function mustLabelFor(
  question: Pick<SetupQuestion, 'must_labels'>,
  job: TeamSetJob
): string | null {
  return question.must_labels[job] ?? null;
}

/** An answer with its class count, for identity and priority rows: "Woman · 3". */
export function answerCountText(answer: AnswerCount): string {
  return `${answer.label} · ${answer.count}`;
}

/** "Students see: "…"" under an identity question. */
export function studentsSeeText(helpText: string): string {
  return `Students see: ${quoted(helpText)}`;
}

/** The three ways to place people who didn't answer. */
export const NON_RESPONDENT_MODE_LABELS: Readonly<Record<NonRespondentsMode, string>> = {
  include: 'Spread them out',
  group: 'Group them together',
  exclude: 'Leave them out',
};

/**
 * The one line under each of those three choices: what the mode does, on a
 * set whose teams are made from a question (projects). Group: any project
 * that runs and has room, the most wanted first.
 */
export const NON_RESPONDENT_MODE_NOTES: Readonly<Record<NonRespondentsMode, string>> = {
  include: 'They fill open seats, at most one per team where possible.',
  group:
    "They're placed together, in teams of their own, on the projects with room, most-wanted first.",
  exclude: 'They get no team from this set.',
};

/** The same lines on a set with no grouping question: no projects to name. */
export const NON_RESPONDENT_MODE_NOTES_FREE: Readonly<Record<NonRespondentsMode, string>> = {
  ...NON_RESPONDENT_MODE_NOTES,
  group: "They're placed together, in teams of their own, after everyone who answered.",
};

/** The mode lines for a set: by its grouping (teams made from a question, or not). */
export function nonRespondentModeNotes(
  grouped: boolean
): Readonly<Record<NonRespondentsMode, string>> {
  return grouped ? NON_RESPONDENT_MODE_NOTES : NON_RESPONDENT_MODE_NOTES_FREE;
}

/** Team shape's note when teams are pairs and an identity rule is on. */
export const PAIRS_IDENTITY_NOTE = 'The identity rule is off for teams of two.';

/** The line under the Projects table. */
export const PROJECTS_FOOTNOTE =
  'A size here overrides the team size for that project. A project with someone pinned to it runs.';

/** "3 of 24". */
export function nonRespondentsCountText(count: number, roster: number): string {
  return `${count} of ${roster}`;
}

/**
 * The People-who-didn't-answer control: one choice per mode, pressed when it
 * is what a run uses. With no stored setting (`mode` null) that is `resolved`,
 * the mode in effect, and the pressed choice is marked as the default rather
 * than as a choice someone made.
 */
export function nonRespondentChoices(
  nonRespondents: Pick<SetupView['non_respondents'], 'mode' | 'resolved'>
): { mode: NonRespondentsMode; label: string; pressed: boolean; isDefault: boolean }[] {
  const pressed = nonRespondents.mode ?? nonRespondents.resolved;
  const isDefault = nonRespondents.mode === null;
  return (['include', 'group', 'exclude'] as const).map(mode => ({
    mode,
    label: NON_RESPONDENT_MODE_LABELS[mode],
    pressed: mode === pressed,
    isDefault: mode === pressed && isDefault,
  }));
}

/** The Checks card's words for a check's level (read by screen readers beside the icon). */
export const CHECK_LEVEL_LABELS: Readonly<Record<CheckLine['level'], string>> = {
  error: 'Error',
  warning: 'Warning',
  ok: 'Passed',
};

/** A check line with the people it names: "… · Ana Ruiz and Ben Osei" (the line alone without names). */
export function checkLineText(line: Pick<CheckLine, 'message' | 'names'>): string {
  return line.names && line.names.length > 0
    ? `${line.message} · ${listJoin(line.names)}`
    : line.message;
}

// ─── Setup's questions ──────────────────────────────────────────────────────

/** The Questions card's heading and empty state. */
export const QUESTIONS_CARD_LABELS = {
  heading: 'Questions',
  subheading: 'What each one does, and how much it counts',
  emptyTitle: 'No questions',
  emptyText: 'This form has no questions to make teams from.',
} as const;

/** What each job is called in a question row's job select. */
export const JOB_LABELS: Readonly<Record<TeamSetJob, string>> = {
  rank: 'Rank',
  fallback: 'Fallback categories',
  owner: 'Owner',
  together: 'Together',
  apart: 'Apart',
  match: 'Match',
  mix: 'Mix',
  balance: 'Balance',
  no_one_alone: "A team won't have exactly one of these",
  note: 'Note',
  priority: 'Shifts priority',
};

/** A question row's fixed words. */
export const QUESTION_ROW_LABELS = {
  job: 'Job',
  noJob: 'None',
  makesTheTeams: 'Makes the teams',
  identityChip: 'Identity question',
  strength: 'Strength',
  weight: 'Weight',
  shift: 'Shift',
  noMustIdentity: "Must isn't offered for identity questions.",
  ruleA: 'Rule A',
  ruleB: 'Rule B',
  noRule: 'None',
  ruleNotInSetup: 'A rule not in this setup',
  answersGroup: 'Effect of each answer',
} as const;

/**
 * A question row control's accessible name, with the question it belongs to
 * (and the rule's job, when given): "Job: Who would you like to work with?",
 * "Strength · Together: Who would you like to work with?".
 */
export function questionControlLabel(
  control: string,
  questionLabel: string,
  job?: TeamSetJob | null
): string {
  const head = job ? `${control} · ${JOB_LABELS[job]}` : control;
  return `${head}: ${questionLabel}`;
}

/** Strength buttons for jobs with a weight. */
export const STRENGTH_LABELS: Readonly<Record<TeamSetStrength, string>> = {
  off: 'Off',
  prefer: 'Prefer',
  must: 'Must',
};

/** Strength buttons for jobs that are only on or off. */
export const ON_OFF_LABELS: Readonly<Record<TeamSetStrength, string>> = {
  off: 'Off',
  prefer: 'On',
  must: 'Must',
};

/** The three effects an answer can have on a priority rule. */
export const PRIORITY_ANSWER_LABELS: Readonly<Record<TeamSetPriorityAnswer, string>> = {
  a: 'A counts more',
  b: 'B counts more',
  none: 'No change',
};

/** "For each student … At a 50% shift the rule that counts more is ×1.5 and the other ×0.5." */
export function priorityHintText(shift: number): string {
  const s = shift / 100;
  return `For each student, the answer moves weight between rules A and B for that student only. At a ${shift}% shift the rule that counts more is ×${formatFactor(1 + s)} and the other ×${formatFactor(1 - s)}.`;
}

/** "1st 0 · 2nd 10 · 3rd 30 · anything else 100"; a dropdown: "picked 0 · anything else 100". */
export function rankCostsText(
  params: TeamSetRule['params'],
  ranks: number,
  dropdown: boolean
): string {
  const costs = params.rank_costs?.length ? params.rank_costs : DEFAULT_RANK_COSTS;
  const unranked = params.unranked_cost ?? DEFAULT_UNRANKED_COST;
  const count = Math.max(1, ranks);
  const parts = Array.from({ length: count }, (_, index) => {
    const cost = costs[index] ?? costs[costs.length - 1] ?? 0;
    return dropdown ? `picked ${cost}` : `${ordinal(index + 1)} ${cost}`;
  });
  return [...parts, `anything else ${unranked}`].join(' · ');
}

/** The one-line hint under a rule; null = none for this job. */
export function jobHintText(
  question: Pick<SetupQuestion, 'type' | 'type_facts'>,
  job: TeamSetJob,
  params: TeamSetRule['params']
): string | null {
  switch (job) {
    case 'rank':
      return rankCostsText(params, question.type_facts.ranks ?? 1, question.type === 'dropdown');
    case 'owner':
      return 'Pitchers go on their own project when it runs.';
    case 'together':
      return 'Mutual requests count double.';
    case 'priority':
      return priorityHintText(params.shift ?? DEFAULT_PRIORITY_SHIFT);
    default:
      return null;
  }
}

/** The identity block's fixed words, under an identity question's rule. */
export const IDENTITY_BLOCK_LABELS = {
  protect: "Don't leave anyone as the only:",
  hint: 'Unticked answers are ignored by this rule.',
} as const;

// ─── Changes ────────────────────────────────────────────────────────────────

/** The header chip: "2 changes since run 4". */
export function changesSinceRunText(count: number, runNumber: number): string {
  return `${plural(count, 'change')} since run ${runNumber}`;
}

/** The runline chip: "1 change since this run". */
export function changesSinceThisRunText(count: number): string {
  return `${plural(count, 'change')} since this run`;
}

/** Results' tray: "2 changes not run yet". */
export function changesNotRunText(count: number): string {
  return `${plural(count, 'change')} not run yet`;
}

/** Can't solve's runline: "Changed since run 5: …; …". */
export function changedSinceRunText(
  runNumber: number,
  items: readonly Pick<SetupChange, 'text'>[]
): string {
  return `Changed since run ${runNumber}: ${items.map(item => item.text).join('; ')}`;
}

// ─── Results ────────────────────────────────────────────────────────────────

/**
 * A run's metrics as the Results tiles, bar and table read them. The pick and
 * placement counts may be null or missing (a run with no grouping question has
 * none: the service's TeamSetMetricsView fits this); everything reading them
 * skips what isn't there.
 */
export type ShownMetrics = Omit<
  TeamSetMetrics,
  'first_choice' | 'top2' | 'top3' | 'placement' | 'responded'
> & {
  first_choice: number | null;
  top2: number | null;
  top3?: number | null;
  placement: Record<TeamSetPlacement, number> | null;
  responded: number | null;
};

/** placement 1 + 2 + 3; runs scored before `top3` existed derive it; null when neither is there. */
export function top3Count(
  metrics: Pick<ShownMetrics, 'top3' | 'placement'> | Pick<TeamSetMetrics, 'top3' | 'placement'>
): number | null {
  if (typeof metrics.top3 === 'number') return metrics.top3;
  const placement = metrics.placement;
  if (!placement) return null;
  return (placement['1'] ?? 0) + (placement['2'] ?? 0) + (placement['3'] ?? 0);
}

export interface MetricTile {
  key: 'first_choice' | 'top3' | 'requests_kept' | 'must_broken' | 'options_open';
  value: number;
  /** The "of y" part; null = a plain count. */
  of: number | null;
  label: string;
}

/**
 * Results tiles: 1st pick and top 3 (grouped runs), requests kept, Must rules
 * broken, projects running (`projects`; default: grouped). A count that isn't
 * there leaves its tile out.
 */
export function metricTiles(
  metrics: ShownMetrics | TeamSetMetrics,
  grouped: boolean,
  projects: boolean = grouped
): MetricTile[] {
  const tiles: MetricTile[] = [];
  const responded = typeof metrics.responded === 'number' ? metrics.responded : null;
  if (grouped && typeof metrics.first_choice === 'number') {
    tiles.push({
      key: 'first_choice',
      value: metrics.first_choice,
      of: responded,
      label: 'got their 1st pick',
    });
  }
  const top3 = grouped ? top3Count(metrics) : null;
  if (top3 !== null) {
    tiles.push({ key: 'top3', value: top3, of: responded, label: 'got a top-3 pick' });
  }
  tiles.push(
    {
      key: 'requests_kept',
      value: metrics.requests.kept,
      of: metrics.requests.total,
      label: metrics.requests.total === 1 ? 'request kept' : 'requests kept',
    },
    {
      key: 'must_broken',
      value: metrics.must_broken,
      of: null,
      label: metrics.must_broken === 1 ? 'Must rule broken' : 'Must rules broken',
    }
  );
  if (projects) {
    tiles.push({
      key: 'options_open',
      value: metrics.options_open,
      of: metrics.options_total,
      label: metrics.options_total === 1 ? 'project running' : 'projects running',
    });
  }
  return tiles;
}

/** The placement bar's legend order and words. */
export const PLACEMENT_LABELS: Readonly<Record<TeamSetPlacement, string>> = {
  '1': '1st',
  '2': '2nd',
  '3': '3rd',
  '4': '4th',
  '5+': '5th or lower',
  fallback: 'In a chosen category',
  missed: 'Not ranked',
  no_answer: "Didn't answer",
};

const PLACEMENT_ORDER: readonly TeamSetPlacement[] = [
  '1',
  '2',
  '3',
  '4',
  '5+',
  'fallback',
  'missed',
  'no_answer',
];

/** The placement bar's segments, in order, zeros left out: "1st · 16"; [] without placements. */
export function placementLegend(
  metrics: Pick<ShownMetrics, 'placement'> | Pick<TeamSetMetrics, 'placement'>
): { placement: TeamSetPlacement; label: string; count: number; text: string }[] {
  const counts = metrics.placement;
  if (!counts) return [];
  return PLACEMENT_ORDER.filter(placement => (counts[placement] ?? 0) > 0).map(placement => ({
    placement,
    label: PLACEMENT_LABELS[placement],
    count: counts[placement],
    text: `${PLACEMENT_LABELS[placement]} · ${counts[placement]}`,
  }));
}

/**
 * A person chip's rank badge: "1st", "not ranked", "no answer". '' (no badge)
 * for someone who answered whose placement is null — the view doesn't show it
 * (it would be read from an answer to an identity question) — and for anyone
 * who answered on a run with no grouping question (`grouped` false: nobody
 * ranked anything).
 */
export function rankBadgeText(
  member: {
    rank: number | null;
    responded: boolean;
    placement?: TeamSetPlacement | null;
  },
  grouped = true
): string {
  if (!member.responded) return 'no answer';
  if (!grouped || member.placement === null) return '';
  return member.rank !== null ? ordinal(member.rank) : 'not ranked';
}

/** "wanted 1st by 7". */
export function wantedFirstText(count: number): string {
  return `wanted 1st by ${count}`;
}

/** A team card's line under its name: "6 people · wanted 1st by 7" ("4 people" in free mode). */
export function teamCardMeta(team: {
  size: number;
  signals: { wanted_first?: number | null };
}): string {
  const size = plural(team.size, 'person', 'people');
  return typeof team.signals.wanted_first === 'number'
    ? `${size} · ${wantedFirstText(team.signals.wanted_first)}`
    : size;
}

export interface SignalChip {
  kind:
    | 'pitcher'
    | 'requests'
    | 'pinned'
    | 'did_not_answer'
    | 'fourth_or_lower'
    | 'seats'
    | 'balance';
  tone: 'good' | 'warn' | 'plain';
  text: string;
}

/**
 * A team's signals as the card reads them. What a view may leave out — the
 * seats (a run grouped by a question now flagged as an identity question has
 * no per-option seats), whether a pitcher is on the team — may be null.
 */
export type ShownTeamSignals = Omit<TeamSignals, 'seats' | 'pitcher_on_team' | 'wanted_first'> & {
  wanted_first?: number | null;
  seats?: { used: number; max: number | null } | null;
  pitcher_on_team?: boolean | null;
};

/**
 * A team card's chips, from the run's own facts; a fact that isn't there
 * gives no chip. `grouped` false (a run with no grouping question) leaves out
 * the pick chip.
 */
export function teamSignalChips(
  signals: ShownTeamSignals | TeamSignals,
  grouped = true
): SignalChip[] {
  const chips: SignalChip[] = [];
  if (signals.pitcher_on_team === true || signals.pitcher_on_team === false) {
    chips.push(
      signals.pitcher_on_team
        ? { kind: 'pitcher', tone: 'good', text: 'pitcher on team' }
        : { kind: 'pitcher', tone: 'warn', text: 'no pitcher on team' }
    );
  }
  if (signals.requests && signals.requests.total > 0) {
    chips.push({
      kind: 'requests',
      tone: signals.requests.kept === signals.requests.total ? 'good' : 'warn',
      text: `${signals.requests.kept} of ${plural(signals.requests.total, 'request')} kept`,
    });
  }
  if (signals.pinned > 0) {
    chips.push({ kind: 'pinned', tone: 'plain', text: `pinned ${signals.pinned}` });
  }
  if (signals.did_not_answer > 0) {
    chips.push({
      kind: 'did_not_answer',
      tone: 'plain',
      text: `${signals.did_not_answer} didn't answer`,
    });
  }
  if (grouped && (signals.fourth_or_lower ?? 0) > 0) {
    chips.push({
      kind: 'fourth_or_lower',
      tone: 'warn',
      text: `${signals.fourth_or_lower} on a 4th pick or lower`,
    });
  }
  const seats = signals.seats;
  if (seats && typeof seats.used === 'number' && typeof seats.max === 'number') {
    chips.push({
      kind: 'seats',
      tone: 'plain',
      text: `${seats.used} of ${plural(seats.max, 'seat')}`,
    });
  }
  for (const balance of signals.balance ?? []) {
    const team = balance.team_avg !== null ? formatAverage(balance.team_avg) : 'no answers';
    const cls = balance.class_avg !== null ? formatAverage(balance.class_avg) : 'no answers';
    chips.push({
      kind: 'balance',
      tone: 'plain',
      text: `${balance.label}: ${team} · class ${cls}`,
    });
  }
  return chips;
}

/** The identity line: "Identity rule held on 5 of 5 teams." (the question named when there are several). */
export function identityHeldText(rule: IdentityRuleView, several: boolean): string {
  const which = several ? `Identity rule on ${quoted(rule.label)}` : 'Identity rule';
  return `${which} held on ${rule.teams_held} of ${plural(rule.teams_total, 'team')}.`;
}

/** After "Show which": the teams the rule missed on, by name. */
export function missedTeamsText(teams: readonly { n: number; name: string }[]): string {
  return `Missed on ${listJoin(teams.map(team => team.name))}.`;
}

// ─── Running ────────────────────────────────────────────────────────────────

/** "Started by you · 6 pins". */
export function runStartedText(
  startedBy: PersonRef | null,
  pins: number,
  viewerId: string
): string {
  const who = startedBy ? whoText(startedBy, viewerId) : UNNAMED;
  return `Started by ${who} · ${plural(pins, 'pin')}`;
}

export interface RunningStep {
  key: 'read' | 'checked' | 'solving' | 'score';
  label: string;
  detail: string | null;
}

/** The Running card's four steps; the first two are done by the time a run is queued. */
export function runningSteps(progress: RunProgress): RunningStep[] {
  return [
    {
      key: 'read',
      label: 'Read answers',
      detail: `${plural(progress.responses, 'response')}, ${plural(progress.people, 'person', 'people')}, ${plural(progress.pins, 'pin')}`,
    },
    {
      key: 'checked',
      label: 'Checked the Must rules',
      detail: progress.warnings > 0 ? plural(progress.warnings, 'warning') : 'Nothing conflicts',
    },
    { key: 'solving', label: 'Solving', detail: null },
    { key: 'score', label: 'Score and save', detail: null },
  ];
}

// ─── Why this placement ─────────────────────────────────────────────────────

/** How a run placed people who didn't answer, as the why panel says it. */
export const NON_RESPONDENT_MODE_PHRASES: Readonly<Record<NonRespondentsMode, string>> = {
  include: 'spread out',
  group: 'grouped together',
  exclude: 'left out',
};

/** "On Trailhead (1st pick) with A, B and C." / "On team 3 with A and B." */
export function whyTeamLine(facts: Pick<PlacementFacts, 'team' | 'rank' | 'responded'>): string {
  const where = facts.team.option ? optionLabel(facts.team.option) : `team ${facts.team.n}`;
  let rank = '';
  if (facts.responded && facts.team.option) {
    rank = facts.rank !== null ? ` (${ordinal(facts.rank)} pick)` : ' (not ranked)';
  }
  const mates = facts.team.mates.map(personName);
  return mates.length > 0 ? `On ${where}${rank} with ${listJoin(mates)}.` : `On ${where}${rank}.`;
}

/** "Pitched Trailhead." (on it) / "Pitched Canopy (not running)." */
export function whyPitchedLine(
  pitched: PlacementFacts['pitched'][number],
  team: PlacementFacts['team']
): string {
  const label = optionLabel(pitched.option);
  const status = optionStatusText(pitched.status);
  return (team.option && pitched.option?.id === team.option.id) || !status
    ? `Pitched ${label}.`
    : `Pitched ${label} (${status}).`;
}

/**
 * A pin that names this person: "Pinned to Studio: has a badge · you",
 * "Pinned together with Omar Farouk · Ana Ruiz · over MCP".
 */
export function whyPinLine(pin: PinView, subjectUserId: string, viewerId: string): string {
  const others = pin.people.filter(person => person.user_id !== subjectUserId).map(personName);
  let what: string;
  switch (pin.kind) {
    case 'on_option':
      what = `Pinned to ${optionLabel(pin.option)}`;
      break;
    case 'not_options':
      what = `Pinned off ${listJoin((pin.options ?? []).map(optionLabel))}`;
      break;
    case 'together':
      what = `Pinned together with ${listJoin(others)}`;
      break;
    case 'apart':
      what = `Pinned apart from ${listJoin(others)}`;
      break;
  }
  const reason = pin.reason ? `: ${pin.reason}` : '';
  const by = pinAttribution(pin, viewerId);
  return `${what}${reason}${by ? ` · ${by}` : ''}`;
}

/** "In run 3: Ledger." / "In run 3: team 2." */
export function whyPreviousLine(previous: NonNullable<PlacementFacts['previous']>): string {
  const where = previous.option ? optionLabel(previous.option) : `team ${previous.team_n}`;
  return `In run ${previous.run_number}: ${where}.`;
}

/**
 * A Shifts-priority answer: `Answered "The project" to "What matters more to
 * you?": "Rank the projects" counts ×1.5 and "Who would you like to work
 * with?" ×0.5 for this student.`, or `…: no change to the weights.`
 */
export function priorityLine(fact: PriorityFact): string {
  const answered = `Answered ${quoted(fact.answer)} to ${quoted(fact.question)}`;
  if (fact.favored === null || fact.other === null) return `${answered}: no change to the weights.`;
  return `${answered}: ${quoted(fact.favored)} counts ×${formatFactor(fact.up)} and ${quoted(fact.other)} ×${formatFactor(fact.down)} for this student.`;
}

/** "Didn't answer the form. People who didn't answer: spread out." */
export function whyNoAnswerLine(mode: NonRespondentsMode): string {
  return `Didn't answer the form. People who didn't answer: ${NON_RESPONDENT_MODE_PHRASES[mode]}.`;
}

export const HIGHER_PICKS_HEADING = 'Higher picks';

/** "Canopy (1st): not running", "Studio (1st): full, 4 of 4". */
export function higherPickLine(pick: PlacementFacts['higher_picks'][number]): string {
  const head = `${optionLabel(pick.option)} (${ordinal(pick.rank)})`;
  const status = optionStatusText(pick.status);
  return status ? `${head}: ${status}` : head;
}

/** "Asked for Priya Nair: kept." / "Asked for Tariq Hassan: not kept (Tariq Hassan is on Echo)." */
export function whyRequestLine(request: PlacementFacts['requests'][number]): string {
  const name = personName(request.user);
  if (request.kept) return `Asked for ${name}: kept.`;
  const where = request.on.option ? optionLabel(request.on.option) : `team ${request.on.team_n}`;
  return `Asked for ${name}: not kept (${name} is on ${where}).`;
}

export interface WhyLine {
  kind:
    | 'team'
    | 'pitched'
    | 'pin'
    | 'previous'
    | 'priority'
    | 'no_answer'
    | 'higher_picks'
    | 'request'
    | 'note';
  text: string;
  /** higher_picks: the picks, one line each. note: the question's label. */
  items?: string[];
}

/**
 * The why panel for one person, in reading order. Facts only; never an
 * identity answer. `placement` gives no line of its own, so a null one (not
 * shown) adds nothing; the didn't-answer line comes only from `responded`.
 */
export function whyLines(facts: PlacementFacts, viewerId: string): WhyLine[] {
  const lines: WhyLine[] = [{ kind: 'team', text: whyTeamLine(facts) }];
  for (const pitched of facts.pitched) {
    lines.push({ kind: 'pitched', text: whyPitchedLine(pitched, facts.team) });
  }
  for (const pin of facts.pins) {
    lines.push({ kind: 'pin', text: whyPinLine(pin, facts.user_id, viewerId) });
  }
  if (facts.previous) lines.push({ kind: 'previous', text: whyPreviousLine(facts.previous) });
  for (const fact of facts.priority ?? [])
    lines.push({ kind: 'priority', text: priorityLine(fact) });
  if (!facts.responded && facts.non_respondents_mode) {
    lines.push({ kind: 'no_answer', text: whyNoAnswerLine(facts.non_respondents_mode) });
  }
  if (facts.higher_picks.length > 0) {
    lines.push({
      kind: 'higher_picks',
      text: HIGHER_PICKS_HEADING,
      items: facts.higher_picks.map(higherPickLine),
    });
  }
  for (const request of facts.requests)
    lines.push({ kind: 'request', text: whyRequestLine(request) });
  for (const note of facts.notes) {
    lines.push({ kind: 'note', text: quoted(note.text), items: [note.field_label] });
  }
  return lines;
}

// ─── Compare ────────────────────────────────────────────────────────────────

/** "Run 4 compared with run 3". */
export function compareTitle(number: number, other: number): string {
  return `Run ${number} compared with run ${other}`;
}

const COMPARE_ROW_LABELS: Readonly<Record<Exclude<CompareMetricKey, 'rule_held'>, string>> = {
  first_choice: 'Got their 1st pick',
  top3: 'Got a top-3 pick',
  requests_kept: 'Requests kept',
  must_broken: 'Must rules broken',
  options_open: 'Projects running',
};

/** A metric row's label; a rule-held row names its question when it is not the identity rule. */
export function compareRowLabel(
  row: Pick<CompareMetricRow, 'key' | 'rule_id' | 'identity'>,
  ruleLabels: Readonly<Record<string, string>> = {}
): string {
  if (row.key !== 'rule_held') return COMPARE_ROW_LABELS[row.key];
  if (row.identity) return 'Identity rule held';
  const label = row.rule_id ? ruleLabels[row.rule_id] : undefined;
  return label ? `Rule on ${quoted(label)} held` : 'Rule held';
}

/** The pick rows, left out of Compare when either run has no grouping question. */
const PICK_ROWS: ReadonlySet<CompareMetricKey> = new Set(['first_choice', 'top3']);

/** Compare's metric rows as the table shows them: no pick rows unless both runs are grouped. */
export function compareRowsShown<R extends Pick<CompareMetricRow, 'key'>>(
  rows: readonly R[],
  grouped: boolean
): R[] {
  return grouped ? [...rows] : rows.filter(row => !PICK_ROWS.has(row.key));
}

/** One side of a row: "11 of 12", "16", "—" when that run has no such number. */
export function compareValueText(row: CompareMetricRow, side: 'run' | 'other'): string {
  const value = row[side];
  if (value === null || value === undefined) return '—';
  const of = row.of?.[side];
  return of !== undefined && of !== null ? `${value} of ${of}` : String(value);
}

/** The Change column: "+3", "−3", "same", "same count, different projects"; '' when not comparable. */
export function deltaText(row: Pick<CompareMetricRow, 'key' | 'delta' | 'same_set'>): string {
  if (row.delta === null) return '';
  if (row.delta === 0) {
    return row.key === 'options_open' && row.same_set === false
      ? 'same count, different projects'
      : 'same';
  }
  return row.delta > 0 ? `+${row.delta}` : `−${Math.abs(row.delta)}`;
}

/** Whether a row's change is better, worse or neither (projects running has no direction). */
export function deltaTone(
  row: Pick<CompareMetricRow, 'key' | 'delta'>
): 'better' | 'worse' | 'same' | 'neutral' | null {
  if (row.delta === null) return null;
  if (row.delta === 0) return 'same';
  if (row.key === 'options_open') return 'neutral';
  const up = row.delta > 0;
  return (row.key === 'must_broken' ? !up : up) ? 'better' : 'worse';
}

/** The "People moved" row: "3 of 24". */
export function peopleMovedText(comparison: Pick<RunComparison, 'moved' | 'unchanged'>): string {
  const moved = comparison.moved.length;
  return `${moved} of ${moved + comparison.unchanged}`;
}

function seatText(seat: RunSeat): string {
  if (!seat.option) return `team ${seat.team_n}`;
  const rank = seat.rank !== null ? ordinal(seat.rank) : 'not ranked';
  return `${optionLabel(seat.option)} (${rank})`;
}

/** "Kofi Mensah · Ledger (1st) → Studio (2nd)" / "Ana Ruiz · team 2 → team 4". */
export function moverLine(mover: RunMover): string {
  return `${personName(mover.user)} · ${seatText(mover.from)} → ${seatText(mover.to)}`;
}

/** "Pinned: has a makerspace badge" (no reason: "Pinned"). */
export function moverPinLine(pin: NonNullable<RunMover['pin']>): string {
  return pin.reason ? `Pinned: ${pin.reason}` : 'Pinned';
}

/** "Now kept: Mira's request for Priya Nair." / "No longer kept: …". */
export function moverRequestLine(request: RunMover['requests'][number]): string {
  const head = request.kind === 'now_kept' ? 'Now kept' : 'No longer kept';
  return `${head}: ${possessive(request.asker)} request for ${personName(request.asked)}.`;
}

/** "The other 21 people are on the same project as in run 3." (free mode: same teammates). */
export function unchangedText(
  comparison: Pick<RunComparison, 'unchanged' | 'other_run_number'>,
  grouped: boolean
): string {
  const k = comparison.unchanged;
  const run = comparison.other_run_number;
  if (grouped) {
    return k === 1
      ? `The other 1 person is on the same project as in run ${run}.`
      : `The other ${k} people are on the same project as in run ${run}.`;
  }
  return k === 1
    ? `The other 1 person has the same teammates as in run ${run}.`
    : `The other ${k} people have the same teammates as in run ${run}.`;
}

/** People in only one of the two runs: "2 people only in run 4", "1 person only in run 3". */
export function joinedLeftText(
  comparison: Pick<RunComparison, 'joined' | 'left' | 'run_number' | 'other_run_number'>
): string[] {
  const lines: string[] = [];
  if (comparison.joined > 0) {
    lines.push(
      `${plural(comparison.joined, 'person', 'people')} only in run ${comparison.run_number}`
    );
  }
  if (comparison.left > 0) {
    lines.push(
      `${plural(comparison.left, 'person', 'people')} only in run ${comparison.other_run_number}`
    );
  }
  return lines;
}

// ─── Create ─────────────────────────────────────────────────────────────────

/** Why Create is disabled, as its note says it; null when it isn't. */
export function createBlockedText(availability: CreateAvailability): string | null {
  if (!availability.allowed) return 'Only classroom owners can create teams.';
  switch (availability.blockedBy) {
    case 'not_solved':
      return "This run isn't solved.";
    case 'stale':
      return 'Answers or the roster changed since this run.';
    case 'creating':
      return 'Teams for this set are being created now.';
    case 'created':
      return 'Teams were already created from this set.';
    case 'create_failed':
      return teamsErrorSentence('already_created', {
        status: 'FAILED',
        run_number: availability.failedRun,
      });
    default:
      return null;
  }
}

/**
 * The dialog's title: "Create 5 teams from run 4". Takes the preview, or the
 * team count and run number (before the preview has answered).
 */
export function createDialogTitle(preview: Pick<CreatePreviewView, 'teams' | 'run_number'>): string;
export function createDialogTitle(teamCount: number, runNumber: number): string;
export function createDialogTitle(
  preview: Pick<CreatePreviewView, 'teams' | 'run_number'> | number,
  runNumber?: number
): string {
  const [teams, run] =
    typeof preview === 'number' ? [preview, runNumber] : [preview.teams.length, preview.run_number];
  return `Create ${plural(teams, 'team')} from run ${run}`;
}

/**
 * A retry's preview: "2 of 5 teams already created." (the count alone when
 * the total isn't given).
 */
export function createRetryText(
  retry: NonNullable<CreatePreviewView['retry']>,
  teamCount?: number
): string {
  const made = retry.teams_already_created;
  return teamCount !== undefined
    ? `${made} of ${plural(teamCount, 'team')} already created.`
    : `${plural(made, 'team')} already created.`;
}

export function createButtonText(teams: number): string {
  return `Create ${plural(teams, 'team')}`;
}

/** "24 students." */
export function studentsText(students: number): string {
  return `${plural(students, 'student')}.`;
}

/** The tag line's note: "New tag." / "Existing tag." */
export function tagStatusText(tag: CreatePreviewView['tag']): string {
  return tag.exists ? 'Existing tag.' : 'New tag.';
}

/** "{set}-{option} → project-teams-trailhead, project-teams-pantry, …". */
export function teamNamesExample(
  preview: Pick<CreatePreviewView, 'name_template' | 'teams'>
): string {
  const names = preview.teams.map(team => team.name);
  const shown = names.slice(0, 2).join(', ');
  return `${preview.name_template} → ${shown}${names.length > 2 ? ', …' : ''}`;
}

/** The banner on every set page while teams are made. */
export function creatingBannerText(
  create: Pick<CreateProgressView, 'total' | 'done' | 'run_number' | 'counts' | 'members_total'>
): string {
  return [
    `Creating ${plural(create.total, 'team')} from run ${create.run_number}`,
    `${create.done} of ${plural(create.total, 'team')} done`,
    `${create.counts.members_added} of ${plural(create.members_total, 'member')} added`,
  ].join(' · ');
}

/** "From run 4 · started by you". */
export function createStartedText(
  create: Pick<CreateProgressView, 'run_number' | 'claimed_by'>,
  viewerId: string
): string {
  return `From run ${create.run_number} · started by ${whoText(create.claimed_by, viewerId)}`;
}

/** One team's row while creating. A live row's GitHub team isn't reported until it is done. */
export function createTeamRowText(team: CreateTeamProgress): string {
  switch (team.state) {
    case 'done':
      return team.github_team
        ? `${team.members_added} of ${plural(team.size, 'member')} · GitHub team made`
        : `${team.members_added} of ${plural(team.size, 'member')}`;
    case 'live':
      return `Adding members · ${team.members_added} of ${team.size}`;
    case 'queued':
      return 'Queued';
    case 'failed':
      return createFailureSentence(team.failure);
  }
}

/** "project-teams-studio was already taken, so this team is project-teams-studio-2." */
export function renamedText(renamed: CreateProgressView['renamed'][number]): string {
  return `${renamed.from} was already taken, so this team is ${renamed.to}.`;
}

/** The Created summary's title: "5 teams created under project-teams". */
export function createdTitle(create: Pick<CreateProgressView, 'counts' | 'tag'>): string {
  return `${plural(create.counts.teams_created, 'team')} created under ${create.tag.name}`;
}

/** "By you on 26 Sep at 3:12 pm, from run 4. 24 students and 5 GitHub teams." (date formatted by the caller). */
export function createdByText(
  create: Pick<CreateProgressView, 'claimed_by' | 'run_number' | 'counts' | 'teams'>,
  viewerId: string,
  finishedOn: string
): string {
  const students = plural(create.counts.members_added, 'student');
  const github = create.teams.filter(team => team.github_team).length;
  const made = github > 0 ? `${students} and ${plural(github, 'GitHub team')}.` : `${students}.`;
  return `By ${whoText(create.claimed_by, viewerId)} on ${finishedOn}, from run ${create.run_number}. ${made}`;
}

/** The fixed line under a created set's summary. */
export const SET_FINISHED_TEXT = 'This set is finished.';

// ─── Can't solve ────────────────────────────────────────────────────────────

const CANT_SOLVE_HEADING = "These rules can't all hold";
const CANT_SOLVE_INTRO = 'No teams were formed. These settings conflict:';

/** Can't solve's heading. */
export function cantSolveHeading(): string {
  return CANT_SOLVE_HEADING;
}

/** The line above Can't solve's list. */
export function cantSolveIntro(): string {
  return CANT_SOLVE_INTRO;
}

/**
 * The students a Can't-solve item names, set before its label; null when it
 * names no one.
 *   pairs      "Ana Ruiz with Ben Osei, Cleo Park with Dev Rao"
 *   + others   "Ana Ruiz with Ben Osei, Cleo Park" (anyone in no pair, after)
 *   no pairs   "Ana Ruiz", "Ana Ruiz, Ben Osei and Cleo Park"
 * A pair whose positions aren't both in `people` is skipped; with none left
 * the names are listed as for no pairs.
 */
export function corePeopleText(item: Pick<CoreItem, 'people' | 'pairs'>): string | null {
  const people = item.people ?? [];
  if (people.length === 0) return null;
  const pairs = (item.pairs ?? []).filter(
    ([a, b]) => a !== b && people[a] !== undefined && people[b] !== undefined
  );
  if (pairs.length === 0) return listJoin(people.map(personName));
  const paired = new Set(pairs.flat());
  return [
    ...pairs.map(([a, b]) => `${personName(people[a])} with ${personName(people[b])}`),
    ...people.filter((_, i) => !paired.has(i)).map(personName),
  ].join(', ');
}

// ─── Fixed labels ───────────────────────────────────────────────────────────

/**
 * The short fixed labels the Teams components show (buttons, headings, field
 * names), in one place so the word scan reads them with the templates.
 */
export const TEAMS_LABELS = {
  // Breadcrumbs, the sets list and the set header.
  forms: 'Forms',
  teams: 'Teams',
  teamSets: 'Team sets',
  noTeamSets: 'No team sets yet',
  setColumn: 'Set',
  statusColumn: 'Status',
  latestRunColumn: 'Latest run',
  updatedColumn: 'Updated',
  teamSetNav: 'Team set',
  run: 'Run',
  name: 'Name',
  startSet: 'Start set',
  compareWith: 'Compare with',
  // Setup's cards.
  teamShape: 'Team shape',
  teamsMadeFrom: 'Teams are made from',
  freeTeams: 'Free teams',
  teamSize: 'Team size',
  min: 'Min',
  max: 'Max',
  rangeTo: 'to',
  numberOfTeams: 'Number of teams',
  teamsPerProject: 'Teams per project',
  whichProjectsRun: 'Which projects run',
  fairness: 'Fairness',
  bestOverall: 'Best overall',
  protectWorstOff: 'Protect the worst-off',
  nonRespondents: "People who didn't answer",
  defaultChip: 'Default',
  pins: 'Pins',
  remove: 'Remove',
  kind: 'Kind',
  person: 'Person',
  otherPerson: 'Other person',
  project: 'Project',
  projects: 'Projects',
  wantedColumn: 'Wanted 1st · top 3',
  size: 'Size',
  pitcher: 'Pitcher',
  pinnedHere: 'Pinned here',
  note: 'Note',
  checks: 'Checks',
  // The set's tabs, the rest of Setup, Runs, Compare and Create.
  setup: 'Setup',
  runs: 'Runs',
  newTeamSet: 'New team set',
  change: 'Change',
  peopleMoved: 'People moved',
  whoMoved: 'Who moved',
  whyTitle: 'Why this placement',
  showWhich: 'Show which',
  discard: 'Discard',
  runAgain: 'Run again',
  checkAgain: 'Check again',
  addPin: 'Add pin',
  addPerson: 'Add person',
  keepOn: 'Keep on',
  moveTo: 'Move to',
  keepApartFrom: 'Keep apart from',
  reason: 'Reason',
  pinned: 'Pinned',
  readNotes: 'Read notes',
  createTeams: 'Create teams…',
  tagForSet: 'Tag for this set',
  teamNames: 'Team names',
  alsoGithub: 'Also create GitHub teams',
  cancel: 'Cancel',
  retry: 'Retry',
  openInTeams: 'Open in Teams',
  makeGroupAssignment: 'Make a group assignment for this tag',
  startNewSet: 'Start a new set from this setup',
  // Screen-reader words beside marks.
  stepDone: 'Done',
} as const;
