/**
 * merge3Units fixture matrix (content-tools plan §3b Phase 7).
 *
 * Pure engine tests — no mocks. The contract under test:
 * one-side edits merge, identical edits merge, true collisions conflict,
 * adds keep their side position, delete-vs-unchanged lets the delete win
 * (moves do NOT protect), delete-vs-edit conflicts, order sequences 3-way
 * merge per scope (top level + each stack), stack membership moves are
 * sequence ops, deck meta merges per-field, and resolutions apply chooser
 * decisions ('ours' = main, 'theirs' = preview).
 */

import { describe, expect, it } from 'vitest';
import {
  DECK_META_CONFLICT_ID,
  DECK_ORDER_CONFLICT_ID,
  deckChildOrderConflictId,
  merge3Units,
} from '../deckMerge.ts';
import type { DeckJson, DeckSlide } from '../deckTypes.ts';

const slide = (id: string, html = `<p>${id}</p>`, extra: Partial<DeckSlide> = {}): DeckSlide => ({
  id,
  html,
  ...extra,
});
const stack = (id: string, children: DeckSlide[], extra: Partial<DeckSlide> = {}): DeckSlide => ({
  id,
  children,
  ...extra,
});
const deck = (slides: DeckSlide[], extra: Partial<DeckJson> = {}): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides,
  ...extra,
});
const topIds = (d: DeckJson): string[] => d.slides.map(s => s.id);
const byId = (d: DeckJson, id: string): DeckSlide => {
  for (const s of d.slides) {
    if (s.id === id) return s;
    for (const c of s.children ?? []) if (c.id === id) return c;
  }
  throw new Error(`missing ${id}`);
};

// ─── One-side edits, every field type ────────────────────────────────────────

describe('merge3Units — one-side edits', () => {
  const mutations: Array<[string, (s: DeckSlide) => void]> = [
    ['html', s => (s.html = '<h1>edited</h1>')],
    ['notes', s => (s.notes = '<p>new notes</p>')],
    ['hidden', s => (s.hidden = true)],
    ['attrs', s => (s.attrs = { 'data-transition': 'fade' })],
  ];

  it.each(mutations)('an ours-only %s change is taken', (_field, mutate) => {
    const base = deck([slide('a'), slide('b')]);
    const ours = deck([slide('a'), slide('b')]);
    mutate(ours.slides[0]);
    const theirs = deck([slide('a'), slide('b')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(result.merged.slides[0]).toEqual(ours.slides[0]);
    expect(result.autoMerged).toBe(1);
  });

  it.each(mutations)('a theirs-only %s change is taken', (_field, mutate) => {
    const base = deck([slide('a'), slide('b')]);
    const ours = deck([slide('a'), slide('b')]);
    const theirs = deck([slide('a'), slide('b')]);
    mutate(theirs.slides[1]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(result.merged.slides[1]).toEqual(theirs.slides[1]);
  });

  it('edits on DIFFERENT slides from each side both land', () => {
    const base = deck([slide('a'), slide('b')]);
    const ours = deck([slide('a', '<p>main edit</p>'), slide('b')]);
    const theirs = deck([slide('a'), slide('b', '<p>preview edit</p>', { hidden: true })]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 'a').html).toBe('<p>main edit</p>');
    expect(byId(result.merged, 'b')).toEqual(slide('b', '<p>preview edit</p>', { hidden: true }));
    expect(result.autoMerged).toBe(2);
  });
});

// ─── Identical edits + true collisions ───────────────────────────────────────

describe('merge3Units — identical edits and collisions', () => {
  it('identical edits on both sides merge without conflict', () => {
    const base = deck([slide('a')]);
    const edited = deck([slide('a', '<p>same edit</p>', { hidden: true })]);

    const result = merge3Units(base, edited, structuredClone(edited));

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 'a')).toEqual(edited.slides[0]);
    expect(result.autoMerged).toBe(1);
  });

  it('both-changed-differently is a content conflict carrying base/ours/theirs', () => {
    const base = deck([slide('a', '<p>original</p>'), slide('b')]);
    const ours = deck([slide('a', '<p>main version</p>'), slide('b')]);
    const theirs = deck([slide('a', '<p>preview version</p>'), slide('b')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: 'a',
        index: '1',
        reason: 'content',
        base: slide('a', '<p>original</p>'),
        ours: slide('a', '<p>main version</p>'),
        theirs: slide('a', '<p>preview version</p>'),
      },
    ]);
    // Pending conflicts carry theirs provisionally.
    expect(byId(result.merged, 'a').html).toBe('<p>preview version</p>');
    expect(result.autoMerged).toBe(0);
  });

  it('different FIELDS of the same slide still collide (the slide is the unit)', () => {
    const base = deck([slide('a', '<p>x</p>')]);
    const ours = deck([slide('a', '<p>main html</p>')]);
    const theirs = deck([slide('a', '<p>x</p>', { notes: '<p>preview notes</p>' })]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: 'a', reason: 'content' });
  });
});

// ─── Adds ────────────────────────────────────────────────────────────────────

describe('merge3Units — adds', () => {
  it('a slide added on one side keeps its position from that side', () => {
    const base = deck([slide('a'), slide('b')]);
    const ours = deck([slide('a'), slide('x', '<p>added on main</p>'), slide('b')]);
    const theirs = deck([slide('a'), slide('b'), slide('y', '<p>added on preview</p>')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['a', 'x', 'b', 'y']);
    expect(result.autoMerged).toBe(2);
  });

  it('the same id added identically on both sides is kept once', () => {
    const base = deck([slide('a')]);
    const withX = deck([slide('a'), slide('x', '<p>same add</p>')]);

    const result = merge3Units(base, withX, structuredClone(withX));

    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['a', 'x']);
  });

  it('the same id added differently on both sides is a both_added conflict (no base)', () => {
    const base = deck([slide('a')]);
    const ours = deck([slide('a'), slide('x', '<p>main add</p>')]);
    const theirs = deck([slide('a'), slide('x', '<p>preview add</p>')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      id: 'x',
      reason: 'both_added',
      ours: { html: '<p>main add</p>' },
      theirs: { html: '<p>preview add</p>' },
    });
    expect('base' in result.conflicts[0]).toBe(false);
  });
});

// ─── Deletes ─────────────────────────────────────────────────────────────────

describe('merge3Units — deletes', () => {
  it('delete vs unchanged: the delete wins (both directions)', () => {
    const base = deck([slide('a'), slide('b')]);
    const oursDeleted = deck([slide('b')]);
    const untouched = deck([slide('a'), slide('b')]);

    expect(topIds(merge3Units(base, oursDeleted, untouched).merged)).toEqual(['b']);
    expect(topIds(merge3Units(base, untouched, oursDeleted).merged)).toEqual(['b']);
    expect(merge3Units(base, oursDeleted, untouched).conflicts).toEqual([]);
  });

  it('deleted on both sides is simply gone', () => {
    const base = deck([slide('a'), slide('b')]);
    const both = deck([slide('b')]);

    const result = merge3Units(base, both, structuredClone(both));
    expect(topIds(result.merged)).toEqual(['b']);
    expect(result.conflicts).toEqual([]);
  });

  it('delete vs EDIT is a delete_vs_edit conflict with null on the deleted side', () => {
    const base = deck([slide('a', '<p>original</p>'), slide('b')]);
    const ours = deck([slide('b')]); // deleted on main
    const theirs = deck([slide('a', '<p>edited on preview</p>'), slide('b')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: 'a',
        index: '1',
        reason: 'delete_vs_edit',
        base: slide('a', '<p>original</p>'),
        ours: null,
        theirs: slide('a', '<p>edited on preview</p>'),
      },
    ]);
    // The edited side survives provisionally.
    expect(topIds(result.merged)).toEqual(['a', 'b']);
  });

  it('a move does NOT protect from a delete (delete wins over an unchanged moved slide)', () => {
    const base = deck([stack('s', [slide('c1'), slide('c2')]), slide('a')]);
    // theirs moves c1 out of the stack to the top level; ours deletes it.
    const ours = deck([stack('s', [slide('c2')]), slide('a')]);
    const theirs = deck([stack('s', [slide('c2')]), slide('a'), slide('c1')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['s', 'a']);
    expect(byId(result.merged, 's').children?.map(c => c.id)).toEqual(['c2']);
  });
});

// ─── Order (top level) ───────────────────────────────────────────────────────

describe('merge3Units — top-level order', () => {
  const abc = () => deck([slide('a'), slide('b'), slide('c')]);

  it('a one-side reorder is taken (and the other side content edit still lands)', () => {
    const base = abc();
    const ours = deck([slide('c'), slide('a'), slide('b')]); // reordered on main
    const theirs = deck([slide('a'), slide('b', '<p>edited</p>'), slide('c')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['c', 'a', 'b']);
    expect(byId(result.merged, 'b').html).toBe('<p>edited</p>');
  });

  it('identical reorders on both sides are not a conflict', () => {
    const swapped = deck([slide('b'), slide('a'), slide('c')]);
    const result = merge3Units(abc(), swapped, structuredClone(swapped));
    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['b', 'a', 'c']);
  });

  it('different reorders on both sides raise the __order__ conflict', () => {
    const base = abc();
    const ours = deck([slide('b'), slide('a'), slide('c')]);
    const theirs = deck([slide('a'), slide('c'), slide('b')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: DECK_ORDER_CONFLICT_ID,
        index: '',
        reason: 'order',
        base: ['a', 'b', 'c'],
        ours: ['b', 'a', 'c'],
        theirs: ['a', 'c', 'b'],
      },
    ]);
    // Provisional order follows theirs.
    expect(topIds(result.merged)).toEqual(['a', 'c', 'b']);
  });

  it('a reorder on one side + an add on the other weave together', () => {
    const base = abc();
    const ours = deck([slide('c'), slide('a'), slide('b')]);
    const theirs = deck([slide('a'), slide('b'), slide('c'), slide('d')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    // Ours' order is the backbone; theirs' d stays anchored after its
    // predecessor c.
    expect(topIds(result.merged)).toEqual(['c', 'd', 'a', 'b']);
  });
});

// ─── Stacks ──────────────────────────────────────────────────────────────────

describe('merge3Units — vertical stacks', () => {
  const baseStack = () => deck([stack('s', [slide('c1'), slide('c2')]), slide('a')]);

  it('different children edited on each side both merge', () => {
    const ours = deck([stack('s', [slide('c1', '<p>main child</p>'), slide('c2')]), slide('a')]);
    const theirs = deck([
      stack('s', [slide('c1'), slide('c2', '<p>preview child</p>')]),
      slide('a'),
    ]);

    const result = merge3Units(baseStack(), ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 'c1').html).toBe('<p>main child</p>');
    expect(byId(result.merged, 'c2').html).toBe('<p>preview child</p>');
    expect(result.autoMerged).toBe(2);
  });

  it('the SAME child edited differently is a conflict on the child (dotted index)', () => {
    const ours = deck([stack('s', [slide('c1', '<p>main</p>'), slide('c2')]), slide('a')]);
    const theirs = deck([stack('s', [slide('c1', '<p>preview</p>'), slide('c2')]), slide('a')]);

    const result = merge3Units(baseStack(), ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: 'c1', index: '1.1', reason: 'content' });
  });

  it('a child added inside a stack on one side is kept in stack position', () => {
    const theirs = deck([
      stack('s', [slide('c1'), slide('c9', '<p>new child</p>'), slide('c2')]),
      slide('a'),
    ]);

    const result = merge3Units(baseStack(), baseStack(), theirs);

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 's').children?.map(c => c.id)).toEqual(['c1', 'c9', 'c2']);
  });

  it("both sides reordering a stack's children differently raises __order__:<stackId>", () => {
    const base = deck([stack('s', [slide('c1'), slide('c2'), slide('c3')])]);
    const ours = deck([stack('s', [slide('c2'), slide('c1'), slide('c3')])]);
    const theirs = deck([stack('s', [slide('c1'), slide('c3'), slide('c2')])]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: deckChildOrderConflictId('s'),
        index: '1',
        reason: 'child_order',
        base: ['c1', 'c2', 'c3'],
        ours: ['c2', 'c1', 'c3'],
        theirs: ['c1', 'c3', 'c2'],
      },
    ]);
  });

  it('a one-side move out of a stack (membership change) merges as sequence ops', () => {
    // theirs moves c1 to the top level; ours edits c1's content.
    const ours = deck([
      stack('s', [slide('c1', '<p>edited on main</p>'), slide('c2')]),
      slide('a'),
    ]);
    const theirs = deck([stack('s', [slide('c2')]), slide('a'), slide('c1')]);

    const result = merge3Units(baseStack(), ours, theirs);

    expect(result.conflicts).toEqual([]);
    // theirs' placement + ours' content.
    expect(topIds(result.merged)).toEqual(['s', 'a', 'c1']);
    expect(byId(result.merged, 'c1').html).toBe('<p>edited on main</p>');
    expect(byId(result.merged, 's').children?.map(c => c.id)).toEqual(['c2']);
  });

  it('moved to DIFFERENT parents on each side is a placement conflict', () => {
    const base = deck([
      stack('s', [slide('c1'), slide('c2')]),
      stack('t', [slide('t1')]),
      slide('a'),
    ]);
    // ours moves c1 to the top level; theirs moves it into stack t.
    const ours = deck([
      stack('s', [slide('c2')]),
      stack('t', [slide('t1')]),
      slide('a'),
      slide('c1'),
    ]);
    const theirs = deck([
      stack('s', [slide('c2')]),
      stack('t', [slide('t1'), slide('c1')]),
      slide('a'),
    ]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: 'c1', reason: 'placement' });
    // Provisionally at theirs' position (inside t).
    expect(byId(result.merged, 't').children?.map(c => c.id)).toEqual(['t1', 'c1']);
  });

  it('deleting a stack vs editing its child is ONE conflict on the container (children absorbed)', () => {
    const base = baseStack();
    const ours = deck([slide('a')]); // stack deleted on main
    const theirs = deck([stack('s', [slide('c1', '<p>edited</p>'), slide('c2')]), slide('a')]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      id: 's',
      reason: 'delete_vs_edit',
      ours: null,
      theirs: { id: 's', children: [{ id: 'c1', html: '<p>edited</p>' }, { id: 'c2' }] },
    });
    // No separate conflict for c1 — it rides with the container decision.
    expect(result.conflicts.some(c => c.id === 'c1')).toBe(false);
  });

  it('container FIELD collisions conflict sans children; the children still merge', () => {
    const base = deck([stack('s', [slide('c1'), slide('c2')], { attrs: { 'data-x': 'base' } })]);
    const ours = deck([stack('s', [slide('c1'), slide('c2')], { attrs: { 'data-x': 'main' } })]);
    const theirs = deck([
      stack('s', [slide('c1'), slide('c2', '<p>preview child</p>')], {
        attrs: { 'data-x': 'preview' },
      }),
    ]);

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict).toMatchObject({ id: 's', reason: 'content' });
    // Fields-only conflict: the displayed sides carry no children.
    expect((conflict.ours as DeckSlide).children).toBeUndefined();
    expect((conflict.theirs as DeckSlide).children).toBeUndefined();
    // The clean child edit still merged underneath.
    expect(byId(result.merged, 'c2').html).toBe('<p>preview child</p>');
  });

  it('a leaf turned into a stack on one side (structure change) rides verbatim', () => {
    const base = deck([slide('l', '<p>leaf</p>'), slide('a')]);
    const theirs = deck([stack('l', [slide('n1'), slide('n2')]), slide('a')]);

    const result = merge3Units(base, structuredClone(base), theirs);

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 'l').children?.map(c => c.id)).toEqual(['n1', 'n2']);
  });
});

// ─── Deck-level meta ─────────────────────────────────────────────────────────

describe('merge3Units — deck meta', () => {
  it('one-side meta changes are taken; different fields from each side both land', () => {
    const base = deck([slide('a')], { customCss: '.x{}' });
    const ours = deck([slide('a')], { customCss: '.y{}' });
    const theirs = deck([slide('a')], { customCss: '.x{}', codeTheme: 'monokai' });

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(result.merged.customCss).toBe('.y{}');
    expect(result.merged.codeTheme).toBe('monokai');
    expect(result.merged.theme).toBe('white');
    expect(result.merged.version).toBe(1);
  });

  it('the same field changed differently raises the single __meta__ conflict', () => {
    const base = deck([slide('a')]);
    const ours = deck([slide('a')], { theme: 'night' });
    const theirs = deck([slide('a')], { theme: 'dracula' });

    const result = merge3Units(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: DECK_META_CONFLICT_ID,
        index: '',
        reason: 'meta',
        base: { theme: 'white' },
        ours: { theme: 'night' },
        theirs: { theme: 'dracula' },
      },
    ]);
    expect(result.merged.theme).toBe('dracula'); // theirs provisionally
  });
});

// ─── Resolutions ─────────────────────────────────────────────────────────────

describe('merge3Units — resolutions', () => {
  it('a content conflict resolves to either side', () => {
    const base = deck([slide('a', '<p>original</p>')]);
    const ours = deck([slide('a', '<p>main</p>')]);
    const theirs = deck([slide('a', '<p>preview</p>')]);

    const keepOurs = merge3Units(base, ours, theirs, { resolutions: { a: 'ours' } });
    expect(keepOurs.conflicts).toEqual([]);
    expect(byId(keepOurs.merged, 'a').html).toBe('<p>main</p>');

    const keepTheirs = merge3Units(base, ours, theirs, { resolutions: { a: 'theirs' } });
    expect(keepTheirs.conflicts).toEqual([]);
    expect(byId(keepTheirs.merged, 'a').html).toBe('<p>preview</p>');
  });

  it('a delete_vs_edit conflict resolves to the delete (gone) or the edit (kept)', () => {
    const base = deck([slide('a', '<p>original</p>'), slide('b')]);
    const ours = deck([slide('b')]);
    const theirs = deck([slide('a', '<p>edited</p>'), slide('b')]);

    const chooseDelete = merge3Units(base, ours, theirs, { resolutions: { a: 'ours' } });
    expect(chooseDelete.conflicts).toEqual([]);
    expect(topIds(chooseDelete.merged)).toEqual(['b']);

    const chooseEdit = merge3Units(base, ours, theirs, { resolutions: { a: 'theirs' } });
    expect(chooseEdit.conflicts).toEqual([]);
    expect(topIds(chooseEdit.merged)).toEqual(['a', 'b']);
    expect(byId(chooseEdit.merged, 'a').html).toBe('<p>edited</p>');
  });

  it("an __order__ resolution picks that side's backbone but keeps the other side's adds", () => {
    const base = deck([slide('a'), slide('b'), slide('c')]);
    const ours = deck([slide('b'), slide('a'), slide('c')]);
    const theirs = deck([slide('a'), slide('c'), slide('b'), slide('d')]);

    const result = merge3Units(base, ours, theirs, {
      resolutions: { [DECK_ORDER_CONFLICT_ID]: 'ours' },
    });

    expect(result.conflicts).toEqual([]);
    // Ours' order wins; theirs' added d is still woven in (after its
    // predecessor b).
    expect(topIds(result.merged)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('a child-order resolution applies to just that stack', () => {
    const base = deck([stack('s', [slide('c1'), slide('c2'), slide('c3')])]);
    const ours = deck([stack('s', [slide('c2'), slide('c1'), slide('c3')])]);
    const theirs = deck([stack('s', [slide('c1'), slide('c3'), slide('c2')])]);

    const result = merge3Units(base, ours, theirs, {
      resolutions: { [deckChildOrderConflictId('s')]: 'ours' },
    });

    expect(result.conflicts).toEqual([]);
    expect(byId(result.merged, 's').children?.map(c => c.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('a __meta__ resolution applies the chosen side for the double-changed fields', () => {
    const base = deck([slide('a')]);
    const ours = deck([slide('a')], { theme: 'night', customCss: '.main{}' });
    const theirs = deck([slide('a')], { theme: 'dracula' });

    const result = merge3Units(base, ours, theirs, {
      resolutions: { [DECK_META_CONFLICT_ID]: 'ours' },
    });

    expect(result.conflicts).toEqual([]);
    expect(result.merged.theme).toBe('night');
    expect(result.merged.customCss).toBe('.main{}'); // one-sided change, untouched by the choice
  });

  it('a placement conflict resolves to the chosen side verbatim (content + position)', () => {
    const base = deck([
      stack('s', [slide('c1'), slide('c2')]),
      stack('t', [slide('t1')]),
      slide('a'),
    ]);
    const ours = deck([
      stack('s', [slide('c2')]),
      stack('t', [slide('t1')]),
      slide('a'),
      slide('c1'),
    ]);
    const theirs = deck([
      stack('s', [slide('c2')]),
      stack('t', [slide('t1'), slide('c1')]),
      slide('a'),
    ]);

    const result = merge3Units(base, ours, theirs, { resolutions: { c1: 'ours' } });

    expect(result.conflicts).toEqual([]);
    expect(topIds(result.merged)).toEqual(['s', 't', 'a', 'c1']);
    expect(byId(result.merged, 't').children?.map(c => c.id)).toEqual(['t1']);
  });
});

// ─── Hygiene ─────────────────────────────────────────────────────────────────

describe('merge3Units — hygiene', () => {
  it('never mutates its inputs', () => {
    const base = deck([stack('s', [slide('c1')]), slide('a')], { customCss: '.x{}' });
    const ours = deck([stack('s', [slide('c1', '<p>edit</p>')]), slide('a')]);
    const theirs = deck([stack('s', [slide('c1')]), slide('a'), slide('z')]);
    const snapshots = [structuredClone(base), structuredClone(ours), structuredClone(theirs)];

    merge3Units(base, ours, theirs);

    expect([base, ours, theirs]).toEqual(snapshots);
  });

  it('a merged result is independent of the inputs (deep-cloned)', () => {
    const base = deck([slide('a')]);
    const ours = deck([slide('a', '<p>edit</p>')]);
    const theirs = deck([slide('a')]);

    const result = merge3Units(base, ours, theirs);
    byId(result.merged, 'a').html = '<p>tampered</p>';

    expect(ours.slides[0].html).toBe('<p>edit</p>');
  });
});
