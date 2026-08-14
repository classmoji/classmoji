/**
 * importProgress pure helpers: buildInitialProgress, applyPhaseUpdate,
 * applyPhaseUpdates, withSummaryParts, overallPercent.
 *
 * The module has no imports at all (that is a load-bearing property — it ships
 * into the browser bundle), so nothing needs stubbing here.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInitialProgress,
  applyPhaseUpdate,
  applyPhaseUpdates,
  withSummaryParts,
  withIdMaps,
  importedSourceIds,
  buildSummaryParts,
  overallPercent,
  IMPORT_PHASE_ORDER,
  IMPORT_PHASE_LABELS,
  COUNTED_PHASE_KEYS,
  SUMMARY_PHASE_KEYS,
  CONTENT_PHASE_KEYS,
  type ImportProgress,
} from '../importProgress.ts';

const allSelected = {
  config: true,
  repositories: true,
  templates: true,
  pages: true,
  slides: true,
  modules: true,
};

describe('buildInitialProgress', () => {
  it('marks selected phases pending and unselected phases skipped', () => {
    const progress = buildInitialProgress({ config: true, pages: true });

    expect(progress.phases.config.status).toBe('pending');
    expect(progress.phases.pages.status).toBe('pending');
    expect(progress.phases.repositories.status).toBe('skipped');
    expect(progress.phases.templates.status).toBe('skipped');
    expect(progress.phases.slides.status).toBe('skipped');
    expect(progress.phases.modules.status).toBe('skipped');
  });

  it('skips everything when no selections are passed at all', () => {
    const progress = buildInitialProgress();
    for (const key of IMPORT_PHASE_ORDER) {
      expect(progress.phases[key].status).toBe('skipped');
    }
  });

  it('seeds counted phases with the totals the caller could count cheaply', () => {
    const progress = buildInitialProgress(allSelected, {
      repositories: 3,
      templates: 2,
      pages: 12,
      slides: 5,
    });

    expect(progress.phases.repositories).toEqual({ status: 'pending', done: 0, total: 3 });
    expect(progress.phases.pages).toEqual({ status: 'pending', done: 0, total: 12 });
    expect(progress.phases.slides).toEqual({ status: 'pending', done: 0, total: 5 });
    expect(progress.phases.templates).toEqual({ status: 'pending', done: 0, total: 2 });
  });

  it('defaults an uncounted total to 0 so the writer can fill it in later', () => {
    const progress = buildInitialProgress({ pages: true });
    expect(progress.phases.pages).toEqual({ status: 'pending', done: 0, total: 0 });
  });

  it('never carries a total on a skipped phase', () => {
    const progress = buildInitialProgress({ pages: false }, { pages: 40 });
    expect(progress.phases.pages).toEqual({ status: 'skipped', done: 0, total: 0 });
  });

  it('coerces a negative or fractional total to a sane whole number', () => {
    const progress = buildInitialProgress(allSelected, { pages: -4, slides: 2.7 });
    expect(progress.phases.pages.total).toBe(0);
    expect(progress.phases.slides.total).toBe(2);
  });
});

describe('phase key constants', () => {
  it('labels every phase in the render order', () => {
    for (const key of IMPORT_PHASE_ORDER) {
      expect(IMPORT_PHASE_LABELS[key]).toBeTruthy();
    }
  });

  it('partitions the phases into exactly counted + summary', () => {
    expect([...COUNTED_PHASE_KEYS, ...SUMMARY_PHASE_KEYS].sort()).toEqual(
      [...IMPORT_PHASE_ORDER].sort()
    );
  });

  it('expands the coarse content phase into its two counted phases', () => {
    // The ImportJob.phase column says `content`; progress tracks pages and
    // slides separately. Guard the mapping so the two cannot drift.
    expect(CONTENT_PHASE_KEYS).toEqual(['pages', 'slides']);
    for (const key of CONTENT_PHASE_KEYS) {
      expect(COUNTED_PHASE_KEYS).toContain(key);
    }
  });
});

describe('applyPhaseUpdate', () => {
  it('does not mutate the input progress object', () => {
    const before = buildInitialProgress(allSelected, { pages: 4 });
    const snapshot = JSON.parse(JSON.stringify(before)) as ImportProgress;

    const after = applyPhaseUpdate(before, { phase: 'pages', status: 'running', done: 2 });

    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after.phases).not.toBe(before.phases);
    expect(after.phases.pages.done).toBe(2);
  });

  it('leaves the other phases untouched', () => {
    const before = buildInitialProgress(allSelected, { pages: 4, slides: 9 });
    const after = applyPhaseUpdate(before, { phase: 'pages', done: 1 });

    expect(after.phases.slides).toEqual(before.phases.slides);
    expect(after.phases.config).toEqual(before.phases.config);
  });

  it('patches only the fields supplied', () => {
    const start = buildInitialProgress(allSelected, { repositories: 5 });
    const running = applyPhaseUpdate(start, { phase: 'repositories', status: 'running' });
    const advanced = applyPhaseUpdate(running, { phase: 'repositories', done: 3 });

    expect(advanced.phases.repositories).toEqual({ status: 'running', done: 3, total: 5 });
  });

  it('raises total and done together in one patch', () => {
    const start = buildInitialProgress(allSelected);
    const after = applyPhaseUpdate(start, {
      phase: 'templates',
      status: 'running',
      done: 2,
      total: 7,
    });

    expect(after.phases.templates).toEqual({ status: 'running', done: 2, total: 7 });
  });

  it('clamps done to the known total so the bar never reads 13/12', () => {
    const start = buildInitialProgress(allSelected, { pages: 12 });
    const after = applyPhaseUpdate(start, { phase: 'pages', done: 13 });
    expect(after.phases.pages.done).toBe(12);
  });

  it('clamps a negative done to zero', () => {
    const start = buildInitialProgress(allSelected, { pages: 12 });
    const after = applyPhaseUpdate(start, { phase: 'pages', done: -3 });
    expect(after.phases.pages.done).toBe(0);
  });

  it('allows done to run ahead while the total is still unknown', () => {
    // total 0 means "not counted yet" — clamping to it would freeze the bar.
    const start = buildInitialProgress({ pages: true });
    const after = applyPhaseUpdate(start, { phase: 'pages', done: 4 });
    expect(after.phases.pages).toEqual({ status: 'pending', done: 4, total: 0 });
  });

  it('sets a summary on a summary phase', () => {
    const start = buildInitialProgress(allSelected);
    const after = applyPhaseUpdate(start, {
      phase: 'config',
      status: 'done',
      summary: 'settings, 4 grade mappings',
    });

    expect(after.phases.config).toEqual({
      status: 'done',
      summary: 'settings, 4 grade mappings',
    });
  });

  it('ignores done/total on a summary phase', () => {
    const start = buildInitialProgress(allSelected);
    const after = applyPhaseUpdate(start, {
      phase: 'modules',
      status: 'running',
      done: 9,
      total: 9,
    });

    expect(after.phases.modules).toEqual({ status: 'running' });
    expect(after.phases.modules).not.toHaveProperty('done');
  });

  it('ignores summary on a counted phase', () => {
    const start = buildInitialProgress(allSelected, { pages: 3 });
    const after = applyPhaseUpdate(start, { phase: 'pages', summary: 'nope' });

    expect(after.phases.pages).not.toHaveProperty('summary');
  });

  describe('note (transient status, e.g. a GitHub rate-limit wait)', () => {
    it('sets a note on a counted phase without disturbing its counts', () => {
      const start = applyPhaseUpdate(buildInitialProgress(allSelected, { templates: 14 }), {
        phase: 'templates',
        status: 'running',
        done: 14,
      });
      const waiting = applyPhaseUpdate(start, {
        phase: 'templates',
        note: 'waiting out GitHub rate limit (~45s)',
      });

      expect(waiting.phases.templates).toEqual({
        status: 'running',
        done: 14,
        total: 14,
        note: 'waiting out GitHub rate limit (~45s)',
      });
    });

    it('clears the note with null once the wait ends', () => {
      const waiting = applyPhaseUpdate(buildInitialProgress(allSelected, { templates: 2 }), {
        phase: 'templates',
        note: 'waiting out GitHub rate limit (~45s)',
      });
      const resumed = applyPhaseUpdate(waiting, { phase: 'templates', note: null });

      expect(resumed.phases.templates).not.toHaveProperty('note');
    });

    it('leaves an existing note alone when note is omitted', () => {
      const waiting = applyPhaseUpdate(buildInitialProgress(allSelected, { templates: 2 }), {
        phase: 'templates',
        note: 'pacing repository creation',
      });
      const advanced = applyPhaseUpdate(waiting, { phase: 'templates', done: 1 });

      expect(advanced.phases.templates.note).toBe('pacing repository creation');
    });

    it('supports notes on summary phases too', () => {
      const after = applyPhaseUpdate(buildInitialProgress(allSelected), {
        phase: 'config',
        note: 'retrying',
      });
      expect(after.phases.config.note).toBe('retrying');
    });
  });
});

describe('applyPhaseUpdates', () => {
  it('applies a batch in order, last write winning per field', () => {
    const after = applyPhaseUpdates(buildInitialProgress(allSelected, { pages: 3 }), [
      { phase: 'pages', status: 'running' },
      { phase: 'pages', done: 1 },
      { phase: 'pages', done: 3 },
      { phase: 'pages', status: 'done' },
      { phase: 'config', status: 'done', summary: 'settings' },
    ]);

    expect(after.phases.pages).toEqual({ status: 'done', done: 3, total: 3 });
    expect(after.phases.config).toEqual({ status: 'done', summary: 'settings' });
  });

  it('returns the input unchanged for an empty batch', () => {
    const start = buildInitialProgress(allSelected);
    expect(applyPhaseUpdates(start, [])).toBe(start);
  });
});

describe('withSummaryParts', () => {
  it('attaches parts without mutating or disturbing the phases', () => {
    const start = buildInitialProgress(allSelected, { pages: 2 });
    const after = withSummaryParts(start, ['3 repositories', '2 pages']);

    expect(after.parts).toEqual(['3 repositories', '2 pages']);
    expect(after.phases).toEqual(start.phases);
    expect(start).not.toHaveProperty('parts');
  });
});

describe('overallPercent', () => {
  it('is 0 for a freshly seeded job', () => {
    expect(overallPercent(buildInitialProgress(allSelected, { pages: 10 }))).toBe(0);
  });

  it('is 100 when every selected phase is done', () => {
    const progress = applyPhaseUpdates(buildInitialProgress({ config: true, modules: true }), [
      { phase: 'config', status: 'done' },
      { phase: 'modules', status: 'done' },
    ]);
    expect(overallPercent(progress)).toBe(100);
  });

  it('excludes skipped phases from the denominator', () => {
    // Importing settings alone must be able to reach 100%.
    const progress = applyPhaseUpdate(buildInitialProgress({ config: true }), {
      phase: 'config',
      status: 'done',
    });
    expect(overallPercent(progress)).toBe(100);
  });

  it('is 100 when nothing at all was selected', () => {
    expect(overallPercent(buildInitialProgress())).toBe(100);
  });

  it('counts a running counted phase by its real done/total ratio', () => {
    // Two phases selected; one done, one half way => 75%.
    const progress = applyPhaseUpdates(buildInitialProgress({ config: true, pages: true }), [
      { phase: 'config', status: 'done' },
      { phase: 'pages', status: 'running', done: 5, total: 10 },
    ]);
    expect(overallPercent(progress)).toBe(75);
  });

  it('treats a failed phase as finished so the bar cannot stall forever', () => {
    const progress = applyPhaseUpdates(buildInitialProgress({ config: true, pages: true }), [
      { phase: 'config', status: 'failed' },
      { phase: 'pages', status: 'done' },
    ]);
    expect(overallPercent(progress)).toBe(100);
  });

  it('contributes nothing for a running phase whose total is unknown', () => {
    const progress = applyPhaseUpdates(buildInitialProgress({ config: true, pages: true }), [
      { phase: 'config', status: 'done' },
      { phase: 'pages', status: 'running', done: 3 },
    ]);
    expect(overallPercent(progress)).toBe(50);
  });

  it('does not credit a pending counted phase that already reports a total', () => {
    const progress = applyPhaseUpdates(buildInitialProgress(allSelected, { pages: 4 }), [
      { phase: 'pages', done: 4 },
    ]);
    // Still pending, so it contributes 0 of the 6 selected phases.
    expect(overallPercent(progress)).toBe(0);
  });

  it('returns a whole number', () => {
    const progress = applyPhaseUpdates(buildInitialProgress(allSelected, { pages: 3 }), [
      { phase: 'pages', status: 'running', done: 1, total: 3 },
    ]);
    expect(Number.isInteger(overallPercent(progress))).toBe(true);
  });
});

describe('withIdMaps', () => {
  const base = buildInitialProgress({ pages: true, slides: true });

  it('attaches maps to a progress object that had none', () => {
    const next = withIdMaps(base, { pages: { 'src-1': 'new-1' } });
    expect(next.id_maps).toEqual({ pages: { 'src-1': 'new-1' } });
  });

  it('MERGES rather than replaces — one phase must not erase another phase hand-off', () => {
    const withRepos = withIdMaps(base, { repositories: { 'r-1': 'R1' }, quizzes: { 'q-1': 'Q1' } });
    const withPages = withIdMaps(withRepos, { pages: { 'p-1': 'P1' } });
    expect(withPages.id_maps).toEqual({
      repositories: { 'r-1': 'R1' },
      quizzes: { 'q-1': 'Q1' },
      pages: { 'p-1': 'P1' },
    });
  });

  it('merges INTO an existing kind, later entries winning per key', () => {
    const first = withIdMaps(base, { pages: { 'p-1': 'P1', 'p-2': 'P2' } });
    const second = withIdMaps(first, { pages: { 'p-2': 'P2-again', 'p-3': 'P3' } });
    expect(second.id_maps?.pages).toEqual({ 'p-1': 'P1', 'p-2': 'P2-again', 'p-3': 'P3' });
  });

  it('is pure: neither the progress nor the incoming maps are mutated', () => {
    const incoming = { pages: { 'p-1': 'P1' } };
    const first = withIdMaps(base, incoming);
    withIdMaps(first, { pages: { 'p-2': 'P2' } });
    expect(base.id_maps).toBeUndefined();
    expect(first.id_maps?.pages).toEqual({ 'p-1': 'P1' });
    expect(incoming).toEqual({ pages: { 'p-1': 'P1' } });
  });

  it('leaves the phases untouched', () => {
    expect(withIdMaps(base, { slides: { 's-1': 'S1' } }).phases).toEqual(base.phases);
  });
});

describe('importedSourceIds', () => {
  it('returns the SOURCE ids already imported for a kind — the resume skip-set', () => {
    const progress = withIdMaps(buildInitialProgress({ pages: true }), {
      pages: { 'src-a': 'new-a', 'src-b': 'new-b' },
    });
    const skip = importedSourceIds(progress, 'pages');
    expect(skip.has('src-a')).toBe(true);
    expect(skip.has('src-b')).toBe(true);
    expect(skip.has('new-a')).toBe(false);
    expect(skip.size).toBe(2);
  });

  it('is empty for a kind never written, and for a job with no maps at all', () => {
    const progress = withIdMaps(buildInitialProgress({ pages: true }), { pages: { a: 'A' } });
    expect(importedSourceIds(progress, 'slides').size).toBe(0);
    expect(importedSourceIds(buildInitialProgress({}), 'pages').size).toBe(0);
  });
});

describe('buildSummaryParts', () => {
  it('emits the fragments in the order the synchronous action used', () => {
    expect(
      buildSummaryParts({
        repositories: 2,
        assignments: 3,
        quizzes: 1,
        settings: true,
        grade_mappings: 4,
        calendar_events: 5,
        pages: 24,
        slides: 19,
        modules: 6,
        duplicated_templates: 2,
      })
    ).toEqual([
      '2 repositories',
      '3 assignments',
      '1 quiz',
      'settings',
      '4 grade mappings',
      '5 calendar events',
      '24 pages',
      '19 slide decks',
      '6 modules',
      '2 duplicated templates',
    ]);
  });

  it('singularizes each count, including the irregular plurals', () => {
    expect(
      buildSummaryParts({
        repositories: 1,
        assignments: 1,
        quizzes: 1,
        grade_mappings: 1,
        calendar_events: 1,
        pages: 1,
        slides: 1,
        modules: 1,
        duplicated_templates: 1,
      })
    ).toEqual([
      '1 repository',
      '1 assignment',
      '1 quiz',
      '1 grade mapping',
      '1 calendar event',
      '1 page',
      '1 slide deck',
      '1 module',
      '1 duplicated template',
    ]);
  });

  it('omits zero and absent counts — a run must never claim "0 quizzes"', () => {
    expect(buildSummaryParts({ pages: 3, slides: 0, quizzes: 0, settings: false })).toEqual([
      '3 pages',
    ]);
    expect(buildSummaryParts({})).toEqual([]);
  });

  it('reports settings as a bare word, with no count', () => {
    expect(buildSummaryParts({ settings: true })).toEqual(['settings']);
  });
});
