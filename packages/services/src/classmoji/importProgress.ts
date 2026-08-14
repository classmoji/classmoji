/**
 * importProgress.ts — the shape of `ImportJob.progress` plus the pure builders
 * and reducer that produce it.
 *
 * Lives in @classmoji/services (not beside any one consumer) because the
 * producers and the readers are in different packages: whatever seeds the row
 * and whatever advances it run server-side, while the progress UI renders the
 * same JSON in the browser. One definition is what stops them drifting.
 *
 * Everything here is PURE — no DB, no GitHub, no clock, and no imports at all,
 * so it is safe to pull into a client bundle (exported as
 * `@classmoji/services/import-progress`; the package root barrel drags octokit
 * and cheerio in and must not be imported from a component).
 *
 * The intended write pattern: the writer owns the canonical progress object in
 * memory and persists it WHOLESALE. These helpers only ever compute a NEW
 * object from an old one, so a persist can never read-modify-write (and lose) a
 * concurrent phase update.
 *
 * Phase keys vs the `ImportJob.phase` column: the column is coarse
 * (config|repositories|templates|content|modules — what the user is told is
 * happening), while progress carries `pages` and `slides` as SEPARATE counted
 * phases. One column value, `content`, covers both — see CONTENT_PHASE_KEYS.
 */

/** Per-phase lifecycle. `skipped` means the user never selected that phase. */
export type ImportPhaseStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

/** The coarse phase names stored on `ImportJob.phase`. */
export type ImportPhaseName = 'config' | 'repositories' | 'templates' | 'content' | 'modules';

/** Every phase tracked inside `progress.phases`. */
export type ImportPhaseKey =
  | 'config'
  | 'repositories'
  | 'templates'
  | 'pages'
  | 'slides'
  | 'modules';

/** The progress phases the coarse `content` phase expands into. */
export const CONTENT_PHASE_KEYS = ['pages', 'slides'] as const;

/** Phases reported as one line — no per-item count is meaningful for them. */
export const SUMMARY_PHASE_KEYS = ['config', 'modules'] as const;

/** Phases long enough to deserve a done/total bar. */
export const COUNTED_PHASE_KEYS = ['repositories', 'templates', 'pages', 'slides'] as const;

/** Stable render order for the per-phase breakdown. */
export const IMPORT_PHASE_ORDER: readonly ImportPhaseKey[] = [
  'config',
  'repositories',
  'templates',
  'pages',
  'slides',
  'modules',
];

/** Human labels for the progress UI (kept beside the order so they can't diverge). */
export const IMPORT_PHASE_LABELS: Record<ImportPhaseKey, string> = {
  config: 'Settings, scales & calendar',
  repositories: 'Repositories',
  templates: 'Template repositories',
  pages: 'Pages',
  slides: 'Slide decks',
  modules: 'Modules',
};

/**
 * A phase reported as a single line.
 *
 * `note` is TRANSIENT operator-facing status for a phase that is still running
 * — most importantly "waiting out GitHub rate limit (~Ns)". Without it a
 * rate-limit backoff looks identical to a hang, which is the exact failure this
 * feature exists to make visible.
 */
export interface SummaryPhaseProgress {
  status: ImportPhaseStatus;
  summary?: string;
  note?: string;
  /** 'warn' = an actual limit/backoff wait (amber in the banner); absent = routine activity (neutral). */
  note_level?: 'info' | 'warn';
}

/** A phase with fine-grained per-item counts. */
export interface CountedPhaseProgress {
  status: ImportPhaseStatus;
  done: number;
  total: number;
  note?: string;
  /** See SummaryPhaseProgress.note_level. */
  note_level?: 'info' | 'warn';
}

/**
 * Source id → new id, per entity kind, accumulated ACROSS phases.
 *
 * Two jobs, both load-bearing:
 *  - HAND-OFF: the modules phase remaps module items onto ids minted by earlier
 *    phases (repositories/quizzes in the synchronous action, pages/slides in the
 *    content task). Carrying them on the row is what lets those phases run in
 *    separate task runs with no shared memory.
 *  - RESUME: a retried run skips source items already present here, so a phase
 *    that died halfway does not duplicate what it already created.
 *
 * `templates` is keyed by source template ref (`owner/name`) rather than an id,
 * matching `TemplateDuplicationSummary.template_map`.
 */
export interface ImportIdMaps {
  repositories?: Record<string, string>;
  quizzes?: Record<string, string>;
  pages?: Record<string, string>;
  slides?: Record<string, string>;
  templates?: Record<string, string>;
}

export interface ImportProgress {
  phases: {
    config: SummaryPhaseProgress;
    repositories: CountedPhaseProgress;
    templates: CountedPhaseProgress;
    pages: CountedPhaseProgress;
    slides: CountedPhaseProgress;
    modules: SummaryPhaseProgress;
  };
  /**
   * Final success-message parts, filled once at COMPLETED. Stored (rather than
   * recomputed in the card) so the wording is built and unit-tested in exactly
   * one place — the same parts the old synchronous action returned inline.
   */
  parts?: string[];
  /** See ImportIdMaps — cross-phase hand-off plus resume skip-sets. */
  id_maps?: ImportIdMaps;
  /**
   * What each finished phase actually imported, accumulated as the run goes.
   * The action seeds the phases it ran synchronously; the task adds its own.
   * `buildSummaryParts` turns this into the final success line — which is why
   * it has to survive on the row rather than living in one phase's memory.
   */
  counts?: ImportSummaryCounts;
}

/**
 * A verbatim snapshot of the `importConfig` the create-classroom request
 * carried, stored on `ImportJob.selections`.
 *
 * The task reads its WHOLE input from this row, which is what keeps the trigger
 * payload a bare `{ importJobId }` and the run replayable. `config` and
 * `repositories` describe phases the action already ran synchronously — they
 * are kept for the record (and for a future resume of those phases), not re-run.
 */
export interface ImportJobSelections {
  /** ClassroomSettings groups, as the create-classroom form posts them. */
  config?: Record<string, boolean>;
  /** Source repository ids the user picked, with their per-repo quiz flag. */
  repositories?: Array<{ id: string; includeQuizzes?: boolean }>;
  content?: {
    pages?: boolean;
    slides?: boolean;
    modules?: boolean;
    duplicateTemplates?: boolean;
  };
}

/** Which phases the user actually asked for. Unselected phases start `skipped`. */
export interface ImportPhaseSelections {
  config?: boolean;
  repositories?: boolean;
  templates?: boolean;
  pages?: boolean;
  slides?: boolean;
  modules?: boolean;
}

/**
 * Totals known cheaply at seed time (the action counts source rows). Anything
 * omitted starts at 0 and is filled in by the task when the phase begins.
 */
export interface ImportPhaseCounts {
  repositories?: number;
  templates?: number;
  pages?: number;
  slides?: number;
}

const countedPhase = (selected: boolean, total: number): CountedPhaseProgress => ({
  status: selected ? 'pending' : 'skipped',
  done: 0,
  total: selected ? Math.max(0, Math.trunc(total)) : 0,
});

const summaryPhase = (selected: boolean): SummaryPhaseProgress => ({
  status: selected ? 'pending' : 'skipped',
});

/**
 * The progress skeleton for a freshly created ImportJob: every selected phase
 * `pending`, every unselected phase `skipped`, counted phases seeded with
 * whatever totals the caller could count cheaply.
 */
export function buildInitialProgress(
  selections: ImportPhaseSelections = {},
  counts: ImportPhaseCounts = {}
): ImportProgress {
  return {
    phases: {
      config: summaryPhase(!!selections.config),
      repositories: countedPhase(!!selections.repositories, counts.repositories ?? 0),
      templates: countedPhase(!!selections.templates, counts.templates ?? 0),
      pages: countedPhase(!!selections.pages, counts.pages ?? 0),
      slides: countedPhase(!!selections.slides, counts.slides ?? 0),
      modules: summaryPhase(!!selections.modules),
    },
  };
}

/**
 * One phase mutation. Every field is optional so callers patch only what they
 * know: a per-item callback sends `{ done }`, a phase start sends
 * `{ status: 'running', total }`, a backoff sends `{ note }`.
 *
 * `note: null` CLEARS the note (a plain `undefined` leaves it alone) — that is
 * how a phase drops its "waiting out GitHub rate limit" line once it resumes.
 * `done`/`summary` are ignored for phases that have no such field, so a caller
 * can hand the same patch shape to any phase.
 */
export interface ImportPhaseUpdate {
  phase: ImportPhaseKey;
  status?: ImportPhaseStatus;
  done?: number;
  total?: number;
  summary?: string;
  note?: string | null;
  /** Rides with `note`; cleared whenever the note clears. */
  note_level?: 'info' | 'warn';
}

const isCountedKey = (key: ImportPhaseKey): key is (typeof COUNTED_PHASE_KEYS)[number] =>
  (COUNTED_PHASE_KEYS as readonly string[]).includes(key);

/** Apply `note` (undefined = leave, null = clear) to a phase patch. The level
 * always follows the note: cleared with it, replaced with it, never orphaned. */
function applyNote<T extends { note?: string; note_level?: 'info' | 'warn' }>(
  next: T,
  note: string | null | undefined,
  level?: 'info' | 'warn'
): T {
  if (note === undefined) return next;
  if (note === null) {
    delete next.note;
    delete next.note_level;
    return next;
  }
  next.note = note;
  if (level) next.note_level = level;
  else delete next.note_level;
  return next;
}

/**
 * Return a NEW progress object with one phase patched. Pure: the input is never
 * mutated, so the task can keep the canonical object and swap it atomically.
 *
 * `done` is clamped to >= 0 and, once a total is known, never exceeds it — a
 * bar that reads 13/12 reads as a bug to the person watching it.
 */
export function applyPhaseUpdate(
  progress: ImportProgress,
  update: ImportPhaseUpdate
): ImportProgress {
  const { phase } = update;
  const phases = { ...progress.phases };

  if (isCountedKey(phase)) {
    const current = progress.phases[phase];
    const next: CountedPhaseProgress = { ...current };
    if (update.status !== undefined) next.status = update.status;
    if (update.total !== undefined) next.total = Math.max(0, Math.trunc(update.total));
    if (update.done !== undefined) next.done = Math.max(0, Math.trunc(update.done));
    // Clamp AFTER both, so a patch that raises total and done together works.
    if (next.total > 0) next.done = Math.min(next.done, next.total);
    phases[phase] = applyNote(next, update.note, update.note_level);
  } else {
    const current = progress.phases[phase];
    const next: SummaryPhaseProgress = { ...current };
    if (update.status !== undefined) next.status = update.status;
    if (update.summary !== undefined) next.summary = update.summary;
    phases[phase] = applyNote(next, update.note, update.note_level);
  }

  return { ...progress, phases };
}

/** Apply several phase patches in order (same purity guarantee). */
export function applyPhaseUpdates(
  progress: ImportProgress,
  updates: readonly ImportPhaseUpdate[]
): ImportProgress {
  return updates.reduce(applyPhaseUpdate, progress);
}

/** Attach the final success-message parts (returns a new object). */
export function withSummaryParts(progress: ImportProgress, parts: string[]): ImportProgress {
  return { ...progress, parts };
}

/** Every kind an ImportIdMaps can carry, so merges iterate one list. */
const ID_MAP_KINDS: readonly (keyof ImportIdMaps)[] = [
  'repositories',
  'quizzes',
  'pages',
  'slides',
  'templates',
];

/**
 * Merge id-map entries into `progress.id_maps` (returns a new object; neither
 * input is mutated).
 *
 * Merge, never replace: a phase only ever knows about the ids IT minted, and
 * blowing away another phase's entries would break both the modules hand-off
 * and the resume skip-sets. Later entries win per key, which makes a re-run of
 * the same item idempotent rather than duplicative.
 */
export function withIdMaps(progress: ImportProgress, maps: ImportIdMaps): ImportProgress {
  const merged: ImportIdMaps = { ...progress.id_maps };
  for (const kind of ID_MAP_KINDS) {
    const incoming = maps[kind];
    if (!incoming) continue;
    merged[kind] = { ...merged[kind], ...incoming };
  }
  return { ...progress, id_maps: merged };
}

/** The ids of one kind already imported — the resume skip-set for that phase. */
export function importedSourceIds(
  progress: ImportProgress,
  kind: keyof ImportIdMaps
): ReadonlySet<string> {
  return new Set(Object.keys(progress.id_maps?.[kind] ?? {}));
}

/**
 * Merge counted results into `progress.counts` (returns a new object).
 *
 * Patch, not replace: each phase only reports what IT imported, and the final
 * success line is the union. A repeated key overwrites rather than adds, so a
 * resumed phase that re-reports its own total stays accurate instead of
 * doubling.
 */
export function withCounts(progress: ImportProgress, patch: ImportSummaryCounts): ImportProgress {
  return { ...progress, counts: { ...progress.counts, ...patch } };
}

/** Everything the final success line can mention. Every field optional/zeroed. */
export interface ImportSummaryCounts {
  repositories?: number;
  assignments?: number;
  quizzes?: number;
  /** true when any ClassroomSettings field was actually copied. */
  settings?: boolean;
  /** emoji + letter-grade mappings, already summed. */
  grade_mappings?: number;
  calendar_events?: number;
  pages?: number;
  slides?: number;
  modules?: number;
  duplicated_templates?: number;
}

/** `1 page` / `3 pages` — irregular plurals passed explicitly. */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * The final success-message fragments, in the order the synchronous action used
 * to emit them ("Classroom created with <parts joined by ', '> imported!").
 *
 * Pure and unit-tested here rather than in the banner, because the phases that
 * produce these counts now finish in a background task long after the action
 * returned — the wording has to be built somewhere both sides agree on.
 * A zero/absent count contributes NOTHING: a run that imported no quizzes must
 * not claim "0 quizzes".
 */
export function buildSummaryParts(counts: ImportSummaryCounts): string[] {
  const parts: string[] = [];
  if (counts.repositories) parts.push(plural(counts.repositories, 'repository', 'repositories'));
  if (counts.assignments) parts.push(plural(counts.assignments, 'assignment'));
  if (counts.quizzes) parts.push(plural(counts.quizzes, 'quiz', 'quizzes'));
  if (counts.settings) parts.push('settings');
  if (counts.grade_mappings) parts.push(plural(counts.grade_mappings, 'grade mapping'));
  if (counts.calendar_events) parts.push(plural(counts.calendar_events, 'calendar event'));
  if (counts.pages) parts.push(plural(counts.pages, 'page'));
  if (counts.slides) parts.push(plural(counts.slides, 'slide deck'));
  if (counts.modules) parts.push(plural(counts.modules, 'module'));
  if (counts.duplicated_templates) {
    parts.push(plural(counts.duplicated_templates, 'duplicated template'));
  }
  return parts;
}

/**
 * Overall completion as a 0-100 integer, for the single top-level bar.
 *
 * Counted phases contribute their real done/total ratio; summary phases are
 * all-or-nothing. `skipped` phases are excluded from the denominator entirely,
 * so an import of settings alone reaches 100%. A `failed` phase counts as
 * finished — the run is over for it, and the bar must not stall at 80% forever.
 */
export function overallPercent(progress: ImportProgress): number {
  let done = 0;
  let total = 0;
  for (const key of IMPORT_PHASE_ORDER) {
    const phase = progress.phases[key];
    if (phase.status === 'skipped') continue;
    total += 1;
    if (phase.status === 'done' || phase.status === 'failed') {
      done += 1;
      continue;
    }
    if (phase.status === 'running' && isCountedKey(key)) {
      const counted = phase as CountedPhaseProgress;
      if (counted.total > 0) done += Math.min(1, counted.done / counted.total);
    }
  }
  if (total === 0) return 100;
  return Math.round((done / total) * 100);
}
