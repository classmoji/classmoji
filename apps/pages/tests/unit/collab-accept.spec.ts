/**
 * Accepting a preview into a live page (collabAccept.ts): merge, then express
 * the result as id-aware ops against the live document — never a git merge
 * into main. The merge engine is injected; here a small stand-in that takes
 * theirs for every block theirs changed and reports a conflict when both
 * sides changed the same block.
 */

import { test, expect } from '@playwright/test';

import { diffBlockOps, MAX_MOVES } from '../../app/components/editor/blockOpsDiff.ts';
import {
  mergeCoverValue,
  planCollabAccept,
  resolutionMap,
  type MergeFn,
} from '../../app/utils/collabAccept.ts';

const p = (id: string, text: string) => ({ id, type: 'paragraph', content: text });

/** Per-block 3-way on top-level ids; theirs' order wins; a both-sides edit conflicts. */
const fakeMerge: MergeFn = (base, ours, theirs, opts = {}) => {
  const byId = (doc: unknown[]) =>
    new Map((doc as Array<{ id: string }>).map(block => [block.id, JSON.stringify(block)]));
  const b = byId(base);
  const o = byId(ours);
  const t = byId(theirs);
  const conflicts: Array<{ id: string }> = [];
  const merged: unknown[] = [];
  let autoMerged = 0;
  const ids = [
    ...(theirs as Array<{ id: string }>).map(x => x.id),
    ...(ours as Array<{ id: string }>).map(x => x.id).filter(id => !t.has(id) && !b.has(id)),
  ];
  for (const id of ids) {
    const bs = b.get(id);
    const os = o.get(id);
    const ts = t.get(id);
    if (os === undefined && bs !== undefined) continue; // deleted live
    const oursChanged = os !== bs;
    const theirsChanged = ts !== bs;
    if (oursChanged && theirsChanged && os !== ts && ts !== undefined && os !== undefined) {
      const choice = opts.resolutions?.[id];
      if (!choice) {
        conflicts.push({ id });
        merged.push(JSON.parse(ts));
        continue;
      }
      merged.push(JSON.parse(choice === 'ours' ? os : ts));
      continue;
    }
    if (theirsChanged && ts !== undefined) autoMerged++;
    merged.push(JSON.parse((theirsChanged ? ts : os) ?? ts!));
  }
  return { merged, conflicts, autoMerged };
};

const noCover = { baseCover: null, oursCover: null, theirsCover: null };

test.describe('planCollabAccept', () => {
  test('a clean merge becomes ops that touch only what the preview changed', () => {
    const base = [p('a', 'one'), p('b', 'two')];
    const ours = [p('a', 'one, typed live'), p('b', 'two')];
    const theirs = [p('a', 'one'), p('b', 'two, from the agent'), p('c', 'added')];
    const plan = planCollabAccept({ base, ours, theirs, ...noCover }, fakeMerge);
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    // The live typing in `a` is not in any op: it stays as it is.
    expect(plan.ops).toEqual([
      { op: 'update', id: 'b', block: p('b', 'two, from the agent') },
      { op: 'insert', blocks: [p('c', 'added')], position: { after: 'b' } },
    ]);
    expect(plan.cover).toBeNull();
  });

  test('a true collision comes back as a report for the chooser', () => {
    const base = [p('a', 'one')];
    const ours = [p('a', 'live')];
    const theirs = [p('a', 'agent')];
    const plan = planCollabAccept({ base, ours, theirs, ...noCover }, fakeMerge);
    expect(plan).toEqual({ kind: 'conflict', units: [{ id: 'a' }], autoMerged: 0 });
  });

  test('the chooser’s picks are passed to the merge', () => {
    const base = [p('a', 'one')];
    const ours = [p('a', 'live')];
    const theirs = [p('a', 'agent')];
    const plan = planCollabAccept(
      { base, ours, theirs, ...noCover, resolutions: { a: 'theirs' } },
      fakeMerge
    );
    expect(plan.kind === 'apply' && plan.ops).toEqual([
      { op: 'update', id: 'a', block: p('a', 'agent') },
    ]);
  });

  test('a long reorder is still ops (no whole-document fallback for a live doc)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const doc = ids.map(id => p(id, id));
    const reversed = [...doc].reverse();
    expect(diffBlockOps(doc, reversed)).toBeNull(); // the editor's save keeps its cap
    expect(MAX_MOVES).toBeLessThan(ids.length - 1);
    const plan = planCollabAccept(
      { base: doc, ours: doc, theirs: reversed, ...noCover },
      fakeMerge
    );
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(plan.ops.every(op => op.op === 'move')).toBe(true);
  });

  test('a merge the op diff cannot express is one replace_all', () => {
    const merge: MergeFn = () => ({
      merged: [p('x', 'x'), p('x', 'duplicate id')],
      conflicts: [],
      autoMerged: 1,
    });
    const plan = planCollabAccept({ base: [], ours: [], theirs: [], ...noCover }, merge);
    expect(plan.kind === 'apply' && plan.ops).toEqual([
      { op: 'replace_all', blocks: [p('x', 'x'), p('x', 'duplicate id')] },
    ]);
  });

  test('the cover changes only when the preview changed it', () => {
    const c1 = { url: 'pages/a/c1.png', position: 50 };
    const c2 = { url: 'pages/a/c2.png', position: 50 };
    const plan = planCollabAccept(
      { base: [], ours: [], theirs: [], baseCover: c1, oursCover: c1, theirsCover: c2 },
      fakeMerge
    );
    expect(plan.kind === 'apply' && plan.cover).toEqual({ value: c2 });
    const untouched = planCollabAccept(
      { base: [], ours: [], theirs: [], baseCover: c1, oursCover: c2, theirsCover: c1 },
      fakeMerge
    );
    expect(untouched.kind === 'apply' && untouched.cover).toBeNull();
  });
});

test.describe('helpers', () => {
  test('mergeCoverValue: a preview-side change wins, otherwise live', () => {
    const a = { url: 'a', position: 50 };
    const b = { url: 'b', position: 50 };
    expect(mergeCoverValue(a, a, b)).toEqual(b);
    expect(mergeCoverValue(a, b, a)).toEqual(b);
    expect(mergeCoverValue(a, b, null)).toEqual(b); // both changed: live wins
    expect(mergeCoverValue(a, a, null)).toBeNull(); // the preview removed it
  });

  test('resolutionMap drops malformed entries', () => {
    expect(
      resolutionMap([
        { id: 'a', choose: 'ours' },
        { id: 'b', choose: 'theirs' },
        { id: 'c', choose: 'both' },
        { id: '', choose: 'ours' },
        { choose: 'ours' },
      ])
    ).toEqual({ a: 'ours', b: 'theirs' });
    expect(resolutionMap(null)).toEqual({});
  });
});
