/**
 * Team sets page — the view models every Teams screen renders.
 *
 * One file of types for the list, the set layout, Setup, Runs (Running,
 * Results, Can't solve), Compare and Create, so the route loaders
 * (`forms/admin/teams/*`, which build these key by key in
 * `teamsData.server.ts`) and the presentational components under
 * `components/forms/teams/` agree on one shape.
 *
 * ── Key casing ─────────────────────────────────────────────────────────────
 * Shapes the service returns (SetupView, RunViewModel, the list row, the poll
 * payload, and everything re-exported from `teamSetExplain.ts`) keep the
 * service's snake_case keys exactly as the release-2 contract writes them, so
 * the loader copies them key by key. What only the page adds around them — the
 * viewer, paths, form facts, action payloads — is camelCase like the rest of
 * apps/pages.
 *
 * ── Browser safety ─────────────────────────────────────────────────────────
 * Type-only imports. Nothing here reaches the client bundle, so the service
 * index (`@classmoji/services`, which loads Prisma and Trigger) may be named
 * for its types; values come only from the pure `./team-set-*` subpaths, and
 * only in `teamsView.ts`.
 *
 * Times are ISO strings: the loaders serialize them, and the components format
 * them after mount (the builder's reason: the browser's zone is not the
 * server's, and formatting during render is a hydration mismatch).
 *
 * Identity-question answers appear in no per-person shape below. The only
 * identity data are class counts (`answer_counts` on an identity question) and
 * per-rule team counts (`identity_rules`); which teams missed comes back only
 * from the `reveal-identity` intent, as team numbers and names.
 */

import type { FormFieldType } from '@classmoji/services/form-contract';
import type {
  TeamSetConfig,
  TeamSetConfigPatchInput,
  TeamSetJob,
  TeamSetRule,
} from '@classmoji/services/team-set-config';
import type {
  ClosedProvenanceView,
  CoreItem as ServiceCoreItem,
  CreateProgressView,
  CreateTeamProgress,
  NonRespondentsMode,
  OptionRef,
  OptionStatus,
  PersonRef,
  PinView,
  PlacementFacts,
  RunComparison,
  SetupChange,
  TeamSetStatus,
  TeamSignals,
} from '@classmoji/services/team-set-explain';
import type { TeamSetMetricsView, TeamSetPlacement } from '@classmoji/services/team-set-metrics';
import type { TeamSetSolveStatus } from '@classmoji/services/team-set-problem';

export type { FormFieldType } from '@classmoji/services/form-contract';
export type {
  TeamSetConfig,
  TeamSetConfigPatchInput,
  TeamSetJob,
  TeamSetPin,
  TeamSetRule,
  TeamSetStrength,
} from '@classmoji/services/team-set-config';
export type {
  ClosedProvenanceView,
  CompareMetricKey,
  CompareMetricRow,
  CreateProgressView,
  CreateTeamProgress,
  CreateTeamState,
  NonRespondentsMode,
  OptionRef,
  OptionRunState,
  OptionStatus,
  PersonRef,
  PinView,
  PlacementFacts,
  PriorityFact,
  RunComparison,
  RunMover,
  RunSeat,
  SetupChange,
  TeamSetCreateStatus,
  TeamSetSetupTab,
  TeamSetStatus,
  TeamSetVia,
  TeamSignals,
} from '@classmoji/services/team-set-explain';
export type {
  TeamSetMetrics,
  TeamSetMetricsView,
  TeamSetNonRespondentMetrics,
  TeamSetPlacement,
  TeamSetRuleMetric,
} from '@classmoji/services/team-set-metrics';
export type { ParsedSrc, TeamSetSolveStatus } from '@classmoji/services/team-set-problem';

/**
 * One entry of a Can't-solve list: the service's CoreItem. A per-student
 * item names its students in `people` (with `pairs`, who is with whom, as
 * positions in `people`), while `label` then holds only the rule part, so the
 * page sets the names apart.
 */
export type CoreItem = ServiceCoreItem & { people?: PersonRef[] };

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** `team_set_runs.status` (the Prisma enum, spelled out so no Prisma type reaches the page). */
export type TeamSetRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SOLVED'
  | 'INFEASIBLE'
  | 'FAILED'
  | 'CANCELED';

/** A run that has not finished: the page polls while one exists. */
export type ActiveRunStatus = Extract<TeamSetRunStatus, 'QUEUED' | 'RUNNING'>;

/** A run and its status, the smallest reference the header and the poll carry. */
export interface RunRef {
  number: number;
  status: TeamSetRunStatus;
}

/**
 * A check line as Setup and the Run button show it. `level: 'ok'` is a passed
 * check (Setup asks for them); `message` is the service's facts-only text;
 * `names` are the people the line is about, resolved at read time. Their user
 * ids stay on the server: nothing on the page reads them.
 */
export interface CheckLine {
  level: 'ok' | 'warning' | 'error';
  code: string;
  message: string;
  srcs?: string[];
  option_ids?: string[];
  names?: string[];
}

/** A run's check line: the facts, never the people (`names`) a line is about. */
export type RunIssueLine = Omit<CheckLine, 'names'>;

/** Setup changes since a run: the header chip, "changes not run yet", Setup. */
export interface SetupChanges {
  /** null = the set has no run yet (then `items` is empty). */
  since_run: number | null;
  items: SetupChange[];
}

// ─── Page envelope (camelCase: the page's own keys) ─────────────────────────

/** Who is looking. Only owners create teams; owners and teachers do everything else. */
export interface TeamsViewer {
  userId: string;
  isOwner: boolean;
}

/** The form a set belongs to, as the header, switcher and list need it. */
export interface TeamsFormFacts {
  slug: string;
  title: string;
  access: 'PUBLIC' | 'CLASSROOM';
  published: boolean;
  /** ISO time; null = no close time. */
  closesAtIso: string | null;
  /** Submitted responses, for the Responses tab count. */
  responsesSubmitted: number;
}

/** Every URL a set's pages link or post to (`teamSetPaths` in teamsView.ts builds them). */
export interface TeamSetPaths {
  /** The form's team sets list. */
  list: string;
  /** The set: the Setup tab, and the ONE action every set mutation posts to. */
  set: string;
  /** Prefix of the run pages: run n is `${runs}/${n}`. */
  runs: string;
  /** The JSON status resource the poll reads. */
  status: string;
}

/** Links on the Created summary; null = the viewer has no such screen (teachers: Teams). */
export interface CreatedLinks {
  teamsUrl: string | null;
  assignmentUrl: string | null;
}

// ─── Team sets list (`forms/admin/teams/list.tsx`) ──────────────────────────

/** One set in the list (`listForForm`). */
export interface TeamSetListRow {
  id: string;
  name: string;
  status: TeamSetStatus;
  run_count: number;
  latest_run: {
    number: number;
    status: TeamSetRunStatus;
    solver_status: TeamSetSolveStatus | null;
    /** From the run's metrics; null until it is solved. */
    first_choice: number | null;
    responded: number | null;
    /** The run's own setup made its teams from a question; false = free teams (no picks). */
    grouped: boolean;
  } | null;
  /** Set once teams were created from the set. */
  created: { run_number: number; teams_created: number; finished_at: string | null } | null;
  /** The set's create, while one is claimed: its run and teams finished of teams in it. */
  create_progress: { run_number: number; done: number; total: number } | null;
  /** ISO time. */
  updated_at: string;
}

export interface TeamSetListData {
  classroom: { slug: string; name: string };
  backUrl: string;
  viewer: TeamsViewer;
  form: TeamsFormFacts;
  sets: TeamSetListRow[];
  /** The name "New team set" starts from. */
  suggestedName: string;
}

// ─── Set layout (`forms/admin/teams/set.tsx`, route id 'team-set') ──────────

/** The set layout loader's data; every set page reads it through `useRouteLoaderData('team-set')`. */
export interface TeamSetLayoutData {
  classroom: { slug: string; name: string };
  backUrl: string;
  viewer: TeamsViewer;
  form: TeamsFormFacts;
  set: { id: string; name: string; status: TeamSetStatus; locked: boolean };
  runCount: number;
  latestRun: RunRef | null;
  /**
   * When the last SOLVED run finished (ISO time); null when no run is solved.
   * A failed create leads the set until a run is solved after it.
   */
  latestSolvedAt: string | null;
  /** The latest run while it is QUEUED or RUNNING. */
  activeRun: (RunRef & { status: ActiveRunStatus }) | null;
  /** The current setup against the latest run's (the header chip). */
  changes: SetupChanges;
  create: CreateProgressView | null;
  /** The poll payload's `signature` for the data this render came from. */
  statusSignature: string;
  paths: TeamSetPaths;
  /**
   * The Create dialog's "Also create GitHub teams" box is shown checked and
   * disabled: classroom-only teams are not offered this release.
   */
  githubTeamsLocked: boolean;
}

/**
 * A create as the status poll reports it: counts and states only. No team
 * name, no person (who claimed it, who wasn't added, their GitHub logins),
 * no tag and no renames: those come with a page load, which is audited, and
 * a page shows the poll's states over the rows it loaded (`liveCreate`).
 */
export interface CreatePollView {
  status: CreateProgressView['status'];
  run_number: number;
  attempt: number;
  total: number;
  done: number;
  counts: CreateProgressView['counts'];
  members_total: number;
  /** ISO time. */
  finished_at: string | null;
  /** One per team, by its `n` in the run's views (1-based). */
  teams: Omit<CreateTeamProgress, 'name'>[];
}

/** What the status resource route returns (`pollStatus`, rebuilt without names). */
export interface SetStatusPayload {
  latest_run: RunRef | null;
  create: CreatePollView | null;
  /** Changes whenever the run or the create moves; opaque to the page. */
  signature: string;
}

/**
 * What the set layout hands its pages through `<Outlet context>`: the layout
 * poll's latest answer (null before the first, and while nothing moves), so
 * a page reads the create's progress without polling a second time.
 */
export interface TeamSetOutletContext {
  live: SetStatusPayload | null;
}

// ─── Setup (`forms/admin/teams/setup.tsx`) ──────────────────────────────────

/** What a question's type line says: "8 options · top 5", "1–5", "optional". */
export interface QuestionTypeFacts {
  options?: number;
  ranks?: number;
  min?: number;
  max?: number;
  required?: boolean;
  /** People pickers: whose names the question lists. */
  source?: 'roster' | 'teaching_team';
}

export interface QuestionCounts {
  answered: number;
  skipped: number;
  /** Together and apart questions: asks, and mutual pairs among them. */
  requests?: number;
  mutual?: number;
  /** Owner questions: people who named an option. */
  pitchers?: number;
  /** Balance questions: the class's average answer. */
  class_average?: number | null;
}

/** An answer and how many students gave it (class counts only, never who). */
export interface AnswerCount {
  option_id: string;
  label: string;
  count: number;
}

export interface SetupQuestion {
  field_id: string;
  label: string;
  type: FormFieldType;
  type_facts: QuestionTypeFacts;
  /** Flagged as an identity question on the form. */
  identity: boolean;
  /** The help text students see under the question; null = none. */
  help_text: string | null;
  /** Jobs this question can take (identity questions: the no-one-alone job only). */
  jobs_allowed: TeamSetJob[];
  /** This question's rules in the current setup. */
  rules: TeamSetRule[];
  /**
   * The Must sentence per job, from `ruleMustLabel` (the one template source,
   * shared with MCP), for the rule's current params. A job missing here has
   * no Must.
   */
  must_labels: Partial<Record<TeamSetJob, string>>;
  counts: QuestionCounts;
  /** Identity and priority questions: class counts per answer. */
  answer_counts?: AnswerCount[];
}

/** A pitcher of an option: a roster student, or an answer from someone no longer on it. */
export interface Pitcher {
  user_id: string | null;
  name: string | null;
  on_roster: boolean;
}

/** One option of the grouping question (the Projects table). */
export interface SetupOption {
  option_id: string;
  label: string;
  description: string | null;
  wanted: { first: number; top3: number };
  /** Solver decides / Always / Closed. */
  runs: 'auto' | 'open' | 'closed';
  /**
   * This option's own team size, as the config stores it (a partial
   * override): a null end follows the set's team size; null = no override.
   */
  size: { min: number | null; max: number | null } | null;
  /** The typed note; null = none. */
  note: string | null;
  /** [] = no pitcher. */
  pitchers: Pitcher[];
  /** On-option pins to this option, with the pin's typed reason (null = none). */
  pinned_here: { pin_id: string; user_id: string; name: string | null; reason: string | null }[];
  /** Only while `runs` is 'closed'. */
  closed?: ClosedProvenanceView;
}

export interface SetupView {
  set: {
    id: string;
    name: string;
    status: TeamSetStatus;
    locked: boolean;
    config: TeamSetConfig;
    /** ISO time. */
    updated_at: string;
  };
  readiness: {
    roster: number;
    answered: number;
    not_answered: number;
    /** ISO time; null = no close time. */
    closes_at: string | null;
    closed: boolean;
  };
  grouping: { mode: 'by_option' | 'free'; field_id: string | null };
  questions: SetupQuestion[];
  shape: {
    people: number;
    /** Team counts the sizes allow; null = none fits. */
    team_count_range: { min: number; max: number } | null;
  };
  non_respondents: {
    /** The setting; null = not set, so the default applies. */
    mode: NonRespondentsMode | null;
    /** What a run would use. */
    resolved: NonRespondentsMode;
    /** People on the roster who haven't answered. */
    count: number;
  };
  pins: PinView[];
  /** Grouped sets only; [] in free mode. */
  options: SetupOption[];
  /** For the pin pickers. */
  roster: PersonRef[];
  /** Passed checks included (`level: 'ok'`). */
  checks: CheckLine[];
  changes: SetupChanges;
}

export interface SetupPageData {
  setup: SetupView;
  /** Set once the set is created or partly created. */
  createdLinks: CreatedLinks | null;
  /** The created run's teams with their members; [] until the set is created. */
  createdTeams: ResultTeam[];
}

// ─── Runs (`forms/admin/teams/run.tsx`) ─────────────────────────────────────

/** One run in the rail. */
export interface RunListItemView {
  number: number;
  status: TeamSetRunStatus;
  /** A run error code on FAILED / CANCELED. */
  error: string | null;
  solver_status: TeamSetSolveStatus | null;
  /** Distance from the best possible, in percent; null = not reported. */
  gap_pct: number | null;
  first_choice: number | null;
  responded: number | null;
  /** The run's own setup made its teams from a question; false = free teams (no picks). */
  grouped: boolean;
  created_by: PersonRef | null;
  /** ISO time. */
  created_at: string;
}

/** What the engine reported, as the runline shows it. */
export interface RunSolverView {
  status: TeamSetSolveStatus;
  gap_pct: number | null;
  core_status?: 'complete' | 'timeout' | 'n/a';
}

/** Counts for the Running steps (no times). */
export interface RunProgress {
  responses: number;
  people: number;
  pins: number;
  /** Check warnings the run carries. */
  warnings: number;
}

/** One identity rule's aggregate: on how many teams it held. Never which, never whose. */
export interface IdentityRuleView {
  rule_id: string;
  /** The identity question's label. */
  label: string;
  teams_held: number;
  teams_total: number;
}

/** How a run left each option of the grouping question. */
export interface OptionStatusRow extends OptionStatus {
  option_id: string;
  label: string | null;
}

export interface ResultMember {
  user_id: string;
  name: string | null;
  /** null when the view doesn't show it: it would be read from an answer to an identity question. */
  placement: TeamSetPlacement | null;
  /** 1-based rank of the team's option in their answer; null = not ranked, or not shown. */
  rank: number | null;
  pinned: boolean;
  responded: boolean;
}

export interface ResultTeam {
  n: number;
  name: string;
  /** null in free mode. */
  option: OptionRef | null;
  size: number;
  members: ResultMember[];
  signals: TeamSignals;
}

/** A run as its page shows it (`describeRun`); the parts a status does not use are empty. */
export interface RunViewModel {
  id: string;
  number: number;
  status: TeamSetRunStatus;
  /** A run error code on FAILED / CANCELED (`runErrorSentence`). */
  error: string | null;
  /** ISO times. */
  created_at: string;
  finished_at: string | null;
  created_by: PersonRef | null;
  solver: RunSolverView | null;
  /**
   * As the service shows it (TeamSetMetricsView): the pick and placement
   * counts are null for free teams, and whatever reads them skips them then.
   */
  metrics: TeamSetMetricsView | null;
  /**
   * The run's own setup made its teams from a question (by option). false =
   * free teams: nobody ranked anything, so the page shows no picks or
   * placements.
   */
  grouped: boolean;
  /** Answers or the roster changed since the run; Create refuses it. */
  stale: boolean;
  stale_reasons: string[];
  /** The run's check lines, without the people they name (the run page lists none). */
  issues: RunIssueLine[];
  /** INFEASIBLE: the settings that collide. */
  core: CoreItem[];
  /** INFEASIBLE: the facts sentence, rendered as given. */
  summary: string | null;
  /** The current setup against this run's (the runline chip). */
  changes_since_run: SetupChange[];
  /** INFEASIBLE: this run's setup against the run before it (the Can't solve runline). */
  changes_from_previous: SetupChanges | null;
  progress: RunProgress;
  identity_rules: IdentityRuleView[];
  non_respondents: { mode: NonRespondentsMode; people: number } | null;
  option_status: OptionStatusRow[];
  teams: ResultTeam[];
}

/** An option the pin block can pin someone to. */
export interface PinTargetOption {
  id: string;
  label: string;
  /** Teams were opened on it in this run. */
  running: boolean;
}

/**
 * Whether this viewer can create teams from this run, and what stops it.
 * `blockedBy` null with `allowed` true = the button works.
 */
export interface CreateAvailability {
  /** The viewer is an owner. */
  allowed: boolean;
  /**
   * 'create_failed': a create from ANOTHER run failed after making teams, so
   * only that run can be retried (`failedRun`).
   */
  blockedBy: 'not_solved' | 'stale' | 'creating' | 'created' | 'create_failed' | null;
  /** The run a failed create came from; set with 'create_failed'. */
  failedRun?: number | null;
}

export interface RunPageData {
  /** Newest first. */
  runs: RunListItemView[];
  run: RunViewModel;
  /** SOLVED: the why facts for everyone in the run. */
  placements: PlacementFacts[];
  /** SOLVED: what the pin block offers. */
  pinTargets: { options: PinTargetOption[]; people: PersonRef[] };
  create: CreateAvailability;
  /** The newest SOLVED run, for "Show run n" while this one runs. */
  lastSolvedRun: number | null;
}

// ─── Compare (`forms/admin/teams/compare.tsx`) ──────────────────────────────

export interface ComparePageData {
  runs: RunListItemView[];
  /** The run compared (n) and the run it is compared with (m), from the URL. */
  runNumber: number;
  otherNumber: number;
  /** null when one of the two runs has no teams (`refusal` says which). */
  comparison: RunComparison | null;
  /** Why there is no comparison: a teamsErrors view (`run_not_solved`). */
  refusal: { code: string; message: string } | null;
  /** The set groups by a question (movers show options); false = free teams (teammates). */
  grouped: boolean;
  /** Question labels by rule id, for the rule-held rows. */
  ruleLabels: Record<string, string>;
}

// ─── Create ─────────────────────────────────────────────────────────────────

/** What the Create dialog shows (`previewCreate`). */
export interface CreatePreviewView {
  run_number: number;
  tag: { name: string; exists: boolean };
  github_teams: boolean;
  name_template: string;
  /** Students across every team. */
  students: number;
  teams: { name: string; option: OptionRef | null; size: number }[];
  /** Facts from the service (e.g. accounts without a GitHub login). */
  warnings: string[];
  /** Retrying a create that failed part way. */
  retry?: { attempt: number; teams_already_created: number };
}

// ─── The set layout's action ────────────────────────────────────────────────

/** Every intent the set layout's action takes. */
export const SET_INTENTS = [
  'patch',
  'run',
  'discard',
  'preview-create',
  'create',
  'retry-create',
  'reveal-identity',
  'new-set-from-setup',
] as const;
export type SetIntent = (typeof SET_INTENTS)[number];

/** What each intent posts besides `intent`. */
export interface SetIntentPayloads {
  /** Autosave: one control's change, as a config patch. */
  patch: { patch: TeamSetConfigPatchInput };
  /** Run the current setup; redirects to the new run. */
  run: Record<string, never>;
  /** Put the setup back to a run's (default: the latest run). */
  discard: { runNumber?: number };
  /** Owner only. Answers `{ preview }`. */
  'preview-create': { runNumber: number };
  /** Owner only. */
  create: { runNumber: number; githubTeams: boolean };
  /** Owner only: resume the create that failed. */
  'retry-create': Record<string, never>;
  /** Answers `{ missedTeams }`: the teams an identity rule missed on, by number and name. */
  'reveal-identity': { runNumber: number };
  /** Copy this setup into a new set; redirects to it. */
  'new-set-from-setup': { name?: string };
}

/** The body the action receives. */
export type SetActionBody<I extends SetIntent = SetIntent> = { intent: I } & SetIntentPayloads[I];

/**
 * What the action answers (when it does not redirect). `intent` says which
 * post it answers. `error` is already a sentence from teamsErrors.ts; a
 * service message never reaches the page.
 */
export interface SetActionData {
  intent: SetIntent;
  ok?: true;
  error?: string;
  /** The code the sentence came from (tests and branching; never shown). */
  errorCode?: string;
  /** What the error lists: taken names, what changed since the run. */
  errorItems?: string[];
  /** `run` refused on its checks: the lines that stop it. */
  issues?: CheckLine[];
  preview?: CreatePreviewView;
  missedTeams?: { n: number; name: string }[];
  /**
   * `discard`: what the run's setup had that the restore left out or put back
   * to its default, as the service words it ("Left out of run 3’s setup: 1
   * pin."). Absent when nothing was.
   */
  notes?: string[];
}
