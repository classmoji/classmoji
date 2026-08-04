/**
 * Unit tests for the diff-at-save planner (deckOpsDiff diffDeckSnapshots).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack —
 * the module under test is pure (no React, no DOM, no network): snapshots
 * are hand-built section lists, exactly what extractDeckSnapshot produces.
 *
 * Contract pinned here: expressible deltas become ops (update / insert /
 * move / delete / reorder) that REPLAY onto the base to exactly the current
 * document (the planner self-verifies by simulation); anything the op
 * vocabulary can't express returns null, so the caller falls back to the
 * whole-document save.
 */

import { test, expect } from '@playwright/test';
import {
  diffDeckSnapshots,
  type DeckSnapshot,
  type DiffSection,
} from '../../app/utils/deckOpsDiff.ts';

/** Leaf section shorthand. */
function s(id: string | null, html: string, extra: Partial<DiffSection> = {}): DiffSection {
  return {
    id,
    html,
    notes: null,
    hidden: false,
    attrs: {},
    children: null,
    ...extra,
  };
}

/** Stack container shorthand. */
function stack(id: string | null, children: DiffSection[], extra: Partial<DiffSection> = {}): DiffSection {
  return {
    id,
    html: null,
    notes: null,
    hidden: false,
    attrs: {},
    children,
    ...extra,
  };
}

function snap(sections: DiffSection[], theme = 'white', codeTheme = 'github'): DeckSnapshot {
  return { theme, codeTheme, sections };
}

const base3 = () => snap([s('aaa', '<p>one</p>'), s('bbb', '<p>two</p>'), s('ccc', '<p>three</p>')]);

test.describe('no-op and updates', () => {
  test('identical snapshots → empty op list (caller falls back to whole-doc no-op semantics)', () => {
    expect(diffDeckSnapshots(base3(), base3())).toEqual([]);
  });

  test('html change → one update op with only html', () => {
    const curr = base3();
    curr.sections[1] = s('bbb', '<h2>edited</h2>');
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      { op: 'update', id: 'bbb', html: '<h2>edited</h2>' },
    ]);
  });

  test('notes added / edited / removed', () => {
    const base = snap([s('aaa', '<p>x</p>', { notes: '<p>old</p>' }), s('bbb', '<p>y</p>')]);
    const curr = snap([s('aaa', '<p>x</p>'), s('bbb', '<p>y</p>', { notes: '<p>new</p>' })]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      // Empty string = remove notes (server contract).
      { op: 'update', id: 'aaa', notes: '' },
      { op: 'update', id: 'bbb', notes: '<p>new</p>' },
    ]);
  });

  test('hidden toggle and attrs change ride one update; cleared attrs post null', () => {
    const base = snap([
      s('aaa', '<p>x</p>', { attrs: { 'data-background-color': '#fff' } }),
      s('bbb', '<p>y</p>'),
    ]);
    const curr = snap([
      s('aaa', '<p>x</p>', { hidden: true }),
      s('bbb', '<p>y</p>', { attrs: { class: 'fancy' } }),
    ]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'update', id: 'aaa', hidden: true, attrs: null },
      { op: 'update', id: 'bbb', attrs: { class: 'fancy' } },
    ]);
  });

  test('untouched slides are never transmitted', () => {
    const curr = base3();
    curr.sections[0] = s('aaa', '<h1>only this</h1>');
    const ops = diffDeckSnapshots(base3(), curr)!;
    expect(ops).toHaveLength(1);
    expect(JSON.stringify(ops)).not.toContain('two');
    expect(JSON.stringify(ops)).not.toContain('three');
  });
});

test.describe('inserts', () => {
  test('new section mid-deck → insert after its predecessor', () => {
    const curr = base3();
    curr.sections.splice(1, 0, s(null, '<p>new</p>'));
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      { op: 'insert', slides: [{ html: '<p>new</p>' }], position: { after: 'aaa' } },
    ]);
  });

  test('new first section → insert at start', () => {
    const curr = base3();
    curr.sections.unshift(s(null, '<p>new</p>', { notes: '<p>n</p>', hidden: true }));
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      {
        op: 'insert',
        slides: [{ html: '<p>new</p>', notes: '<p>n</p>', hidden: true }],
        position: { at: 'start' },
      },
    ]);
  });

  test('consecutive new sections group into ONE insert', () => {
    const curr = base3();
    curr.sections.splice(2, 0, s(null, '<p>n1</p>'), s(null, '<p>n2</p>'));
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      {
        op: 'insert',
        slides: [{ html: '<p>n1</p>' }, { html: '<p>n2</p>' }],
        position: { after: 'bbb' },
      },
    ]);
  });

  test('new vertical stack (id-less container with new children) → insert with children', () => {
    const curr = base3();
    curr.sections.push(stack(null, [s(null, '<p>c1</p>'), s(null, '<p>c2</p>')]));
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      {
        op: 'insert',
        slides: [{ children: [{ html: '<p>c1</p>' }, { html: '<p>c2</p>' }] }],
        position: { after: 'ccc' },
      },
    ]);
  });

  test('new child appended inside an existing stack → insert after the last child', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>')])]);
    const curr = snap([
      s('aaa', '<p>x</p>'),
      stack('st', [s('c1', '<p>c1</p>'), s(null, '<p>c2</p>')]),
    ]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'insert', slides: [{ html: '<p>c2</p>' }], position: { after: 'c1' } },
    ]);
  });

  test('new FIRST child of a stack has no expressible anchor → null', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>')])]);
    const curr = snap([
      s('aaa', '<p>x</p>'),
      stack('st', [s(null, '<p>new</p>'), s('c1', '<p>c1</p>')]),
    ]);
    expect(diffDeckSnapshots(base, curr)).toBeNull();
  });
});

test.describe('deletes, reorder, moves', () => {
  test('removed section → delete op', () => {
    const curr = snap([s('aaa', '<p>one</p>'), s('ccc', '<p>three</p>')]);
    expect(diffDeckSnapshots(base3(), curr)).toEqual([{ op: 'delete', id: 'bbb' }]);
  });

  test('deleted stack (children gone with it) → one container delete', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>'), s('c2', '<p>c2</p>')])]);
    const curr = snap([s('aaa', '<p>x</p>')]);
    expect(diffDeckSnapshots(base, curr)).toEqual([{ op: 'delete', id: 'st' }]);
  });

  test('top-level reorder → one reorder op with the full permutation', () => {
    const curr = snap([s('ccc', '<p>three</p>'), s('aaa', '<p>one</p>'), s('bbb', '<p>two</p>')]);
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      { op: 'reorder', order: ['ccc', 'aaa', 'bbb'] },
    ]);
  });

  test('edit + delete + reorder + insert compose in replay order', () => {
    const curr = snap([
      s('ccc', '<h3>edited three</h3>'),
      s(null, '<p>new</p>'),
      s('aaa', '<p>one</p>'),
    ]);
    expect(diffDeckSnapshots(base3(), curr)).toEqual([
      { op: 'update', id: 'ccc', html: '<h3>edited three</h3>' },
      { op: 'delete', id: 'bbb' },
      { op: 'reorder', order: ['ccc', 'aaa'] },
      { op: 'insert', slides: [{ html: '<p>new</p>' }], position: { after: 'ccc' } },
    ]);
  });

  test('stack child reorder → after-anchored move chain', () => {
    const base = snap([
      s('aaa', '<p>x</p>'),
      stack('st', [s('c1', '<p>c1</p>'), s('c2', '<p>c2</p>'), s('c3', '<p>c3</p>')]),
    ]);
    const curr = snap([
      s('aaa', '<p>x</p>'),
      stack('st', [s('c3', '<p>c3</p>'), s('c1', '<p>c1</p>'), s('c2', '<p>c2</p>')]),
    ]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'move', id: 'c1', position: { after: 'c3' } },
      { op: 'move', id: 'c2', position: { after: 'c1' } },
    ]);
  });

  test('child escapes its stack to the top level → move op', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>'), s('c2', '<p>c2</p>')])]);
    const curr = snap([
      s('aaa', '<p>x</p>'),
      stack('st', [s('c2', '<p>c2</p>')]),
      s('c1', '<p>c1</p>'),
    ]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'move', id: 'c1', position: { after: 'st' } },
    ]);
  });

  test('top-level slide joins a stack (after an existing child) → move op', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>')]), s('bbb', '<p>y</p>')]);
    const curr = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>'), s('bbb', '<p>y</p>')])]);
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'move', id: 'bbb', position: { after: 'c1' } },
    ]);
  });

  test('move to the FRONT of a stack from outside → null (no expressible anchor)', () => {
    const base = snap([s('aaa', '<p>x</p>'), stack('st', [s('c1', '<p>c1</p>')]), s('bbb', '<p>y</p>')]);
    const curr = snap([s('aaa', '<p>x</p>'), stack('st', [s('bbb', '<p>y</p>'), s('c1', '<p>c1</p>')])]);
    expect(diffDeckSnapshots(base, curr)).toBeNull();
  });
});

test.describe('anomalies → null (whole-doc fallback)', () => {
  test('theme or code-theme change', () => {
    expect(diffDeckSnapshots(base3(), snap(base3().sections, 'black'))).toBeNull();
    expect(diffDeckSnapshots(base3(), snap(base3().sections, 'white', 'monokai'))).toBeNull();
  });

  test('duplicate ids in the current document (editor slide duplication)', () => {
    const curr = base3();
    curr.sections.push(s('aaa', '<p>dup</p>'));
    expect(diffDeckSnapshots(base3(), curr)).toBeNull();
  });

  test('unknown id in the current document (foreign paste)', () => {
    const curr = base3();
    curr.sections.push(s('zzz', '<p>pasted</p>'));
    expect(diffDeckSnapshots(base3(), curr)).toBeNull();
  });

  test('baseline missing an id (never diffable against an untagged base)', () => {
    const base = snap([s('aaa', '<p>x</p>'), s(null, '<p>untagged</p>')]);
    expect(diffDeckSnapshots(base, base)).toBeNull();
  });

  test('leaf became a stack container (containerness change)', () => {
    const curr = base3();
    curr.sections[0] = stack('aaa', [s(null, '<p>c</p>')]);
    expect(diffDeckSnapshots(base3(), curr)).toBeNull();
  });

  test('NEW stack wrapping EXISTING slides (overview grouping) is inexpressible', () => {
    const curr = snap([stack(null, [s('aaa', '<p>one</p>'), s('bbb', '<p>two</p>')]), s('ccc', '<p>three</p>')]);
    expect(diffDeckSnapshots(base3(), curr)).toBeNull();
  });

  test('replacing every slide (delete-last engine refusal) → null', () => {
    const curr = snap([s(null, '<p>all new</p>')]);
    expect(diffDeckSnapshots(base3(), curr)).toBeNull();
  });

  test('NOT an anomaly: dissolved stack with a surviving child — move-out precedes the delete', () => {
    const base = snap([stack('st', [s('c1', '<p>c1</p>')]), s('aaa', '<p>x</p>')]);
    const curr = snap([s('c1', '<p>c1</p>'), s('aaa', '<p>x</p>')]);
    // c1 moves OUT to the root front (expressible at root) BEFORE st deletes,
    // so the surviving child is never destroyed with its old container.
    expect(diffDeckSnapshots(base, curr)).toEqual([
      { op: 'move', id: 'c1', position: { at: 'start' } },
      { op: 'delete', id: 'st' },
    ]);
  });
});
