/**
 * Unit tests for the diff-at-save helper (blockOpsDiff.ts).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack —
 * the module under test is pure (no React, no BlockNote, no network).
 *
 * The contract under test: diffBlockOps(baseline, current) emits the minimal
 * update/delete/move/insert script the server replays against the SAME base
 * (ops order: updates → deletes → moves → inserts), and returns null for any
 * document it can't diff trustworthily — the caller then falls back to the
 * whole-document save.
 */

import { test, expect } from '@playwright/test';
import {
  diffBlockOps,
  MAX_MOVES,
  type BlockOp,
} from '../../app/components/editor/blockOpsDiff.ts';

const block = (id: string, text: string, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default' },
  content: [{ type: 'text', text, styles: {} }],
  children,
});

/**
 * Reference replay of the server's applyBlockOps semantics (top-level only —
 * the diff never emits nested-addressed ops): proves each emitted script
 * reproduces `current` exactly when applied to `baseline`.
 */
function replay(baseline: { id: string }[], ops: BlockOp[]): unknown[] {
  let doc: { id: string }[] = structuredClone(baseline);
  const indexOf = (id: string) => {
    const index = doc.findIndex(b => b.id === id);
    if (index === -1) throw new Error(`unknown id ${id}`);
    return index;
  };
  const insertAt = (blocks: unknown[], position: { after?: string; at?: string }) => {
    if (position.after) doc.splice(indexOf(position.after) + 1, 0, ...(blocks as { id: string }[]));
    else if (position.at === 'start') doc.unshift(...(blocks as { id: string }[]));
    else doc.push(...(blocks as { id: string }[]));
  };
  for (const op of ops) {
    if (op.op === 'update') doc[indexOf(op.id)] = op.block as { id: string };
    else if (op.op === 'delete') doc.splice(indexOf(op.id), 1);
    else if (op.op === 'move') {
      const [moved] = doc.splice(indexOf(op.id), 1);
      insertAt([moved], op.position as { after?: string; at?: string });
    } else insertAt(op.blocks, op.position as { after?: string; at?: string });
  }
  return doc;
}

test.describe('diffBlockOps — update', () => {
  test('a changed block becomes one update op; untouched blocks never transmit', () => {
    const baseline = [block('a', 'one'), block('b', 'two'), block('c', 'three')];
    const current = [block('a', 'one EDITED'), block('b', 'two'), block('c', 'three')];

    const ops = diffBlockOps(baseline, current);

    expect(ops).toEqual([{ op: 'update', id: 'a', block: current[0] }]);
  });

  test('a changed nested child = an update op on its TOP-LEVEL block (the merge unit)', () => {
    const baseline = [block('a', 'one', [block('a1', 'child')]), block('b', 'two')];
    const current = [block('a', 'one', [block('a1', 'child EDITED')]), block('b', 'two')];

    const ops = diffBlockOps(baseline, current);

    expect(ops).toEqual([{ op: 'update', id: 'a', block: current[0] }]);
  });

  test('canonically identical docs (only key order differs) → empty script, not an update', () => {
    const baseline = [{ id: 'a', type: 'paragraph', content: [] }];
    const current = [{ content: [], type: 'paragraph', id: 'a' }];

    expect(diffBlockOps(baseline, current)).toEqual([]);
  });
});

test.describe('diffBlockOps — insert', () => {
  test('a new block mid-document inserts after its left neighbor', () => {
    const baseline = [block('a', 'one'), block('b', 'two')];
    const current = [block('a', 'one'), block('x', 'new'), block('b', 'two')];

    expect(diffBlockOps(baseline, current)).toEqual([
      { op: 'insert', blocks: [current[1]], position: { after: 'a' } },
    ]);
  });

  test('a new block at the top inserts at start; consecutive new blocks group into one op', () => {
    const baseline = [block('a', 'one')];
    const current = [block('x', 'new1'), block('y', 'new2'), block('a', 'one')];

    expect(diffBlockOps(baseline, current)).toEqual([
      { op: 'insert', blocks: [current[0], current[1]], position: { at: 'start' } },
    ]);
  });

  test('an empty baseline (fresh doc) becomes one insert run at start', () => {
    const current = [block('a', 'one'), block('b', 'two')];
    expect(diffBlockOps([], current)).toEqual([
      { op: 'insert', blocks: current, position: { at: 'start' } },
    ]);
  });
});

test.describe('diffBlockOps — delete', () => {
  test('removed blocks become delete ops', () => {
    const baseline = [block('a', 'one'), block('b', 'two'), block('c', 'three')];
    const current = [block('b', 'two')];

    expect(diffBlockOps(baseline, current)).toEqual([
      { op: 'delete', id: 'a' },
      { op: 'delete', id: 'c' },
    ]);
  });
});

test.describe('diffBlockOps — move', () => {
  test('a single block moved emits ONE move op that replays to the exact order', () => {
    const baseline = [block('a', 'one'), block('b', 'two'), block('c', 'three')];
    const current = [block('c', 'three'), block('a', 'one'), block('b', 'two')];

    const ops = diffBlockOps(baseline, current)!;

    expect(ops).toEqual([{ op: 'move', id: 'c', position: { at: 'start' } }]);
    expect(replay(baseline, ops)).toEqual(current);
  });

  test('an adjacent swap emits one move', () => {
    const baseline = [block('a', 'one'), block('b', 'two'), block('c', 'three')];
    const current = [block('a', 'one'), block('c', 'three'), block('b', 'two')];

    const ops = diffBlockOps(baseline, current)!;

    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('move');
    expect(replay(baseline, ops)).toEqual(current);
  });

  test('mixed update+delete+move+insert replays to the exact target document', () => {
    const baseline = [block('a', 'one'), block('b', 'two'), block('c', 'three'), block('d', 'four')];
    const current = [
      block('d', 'four'),
      block('a', 'one EDITED'),
      block('x', 'new'),
      block('c', 'three'),
    ];

    const ops = diffBlockOps(baseline, current)!;

    expect(ops).not.toBeNull();
    // Op order: updates → deletes → moves → inserts.
    expect(ops.map(o => o.op)).toEqual(['update', 'delete', 'move', 'insert']);
    expect(replay(baseline, ops)).toEqual(current);
  });
});

test.describe('diffBlockOps — null fallbacks (whole-document save)', () => {
  test(`a complex permutation (more than ${MAX_MOVES} blocks out of place) → null`, () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const baseline = ids.map(id => block(id, id));
    const current = [...baseline].reverse();

    expect(diffBlockOps(baseline, current)).toBeNull();
  });

  test('no baseline (null/undefined/non-array) → null', () => {
    const doc = [block('a', 'one')];
    expect(diffBlockOps(null, doc)).toBeNull();
    expect(diffBlockOps(undefined, doc)).toBeNull();
    expect(diffBlockOps('<html>legacy</html>', doc)).toBeNull();
    expect(diffBlockOps(doc, null)).toBeNull();
  });

  test('a top-level block without a usable id → null', () => {
    const baseline = [block('a', 'one')];
    expect(diffBlockOps(baseline, [{ type: 'paragraph', content: [] }])).toBeNull();
    expect(diffBlockOps(baseline, [{ id: '', type: 'paragraph' }])).toBeNull();
    expect(diffBlockOps([{ type: 'paragraph' }], baseline)).toBeNull();
  });

  test('duplicate ids anywhere in either tree → null', () => {
    const dupTop = [block('a', 'one'), block('a', 'clone')];
    const ok = [block('a', 'one')];
    expect(diffBlockOps(dupTop, ok)).toBeNull();
    expect(diffBlockOps(ok, dupTop)).toBeNull();

    // Nested duplicate of a top-level id — id-addressed ops would be ambiguous.
    const dupNested = [block('a', 'one', [block('b', 'child')]), block('b', 'two')];
    expect(diffBlockOps(dupNested, ok)).toBeNull();
    expect(diffBlockOps(ok, dupNested)).toBeNull();
  });

  test('an id that changes scope (nested ⇄ top-level) → null', () => {
    // b escapes its parent to top level: the op vocabulary cannot express a
    // cross-scope move without id churn — whole-doc save handles it.
    const baseline = [block('a', 'one', [block('b', 'child')])];
    const current = [block('a', 'one'), block('b', 'child')];
    expect(diffBlockOps(baseline, current)).toBeNull();

    // ...and the reverse (b tucked INTO a parent).
    expect(diffBlockOps(current, baseline)).toBeNull();
  });

  test('identical documents → empty script (caller skips the save)', () => {
    const doc = [block('a', 'one'), block('b', 'two')];
    expect(diffBlockOps(doc, structuredClone(doc))).toEqual([]);
  });
});
