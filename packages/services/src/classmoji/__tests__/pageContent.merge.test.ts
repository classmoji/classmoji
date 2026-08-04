/**
 * merge3Blocks fixture matrix (content-tools plan §3b Phase 7).
 *
 * Pure engine tests — ContentService is stubbed only so importing the service
 * module never touches the git-provider chain. The contract under test:
 * one-side edits merge, identical edits merge, true collisions conflict,
 * adds keep their side position, delete-vs-unchanged lets the delete win,
 * delete-vs-edit conflicts, the top-level order 3-way merges with the
 * __order__ sentinel on double reorders, children subtrees ride with their
 * top-level block, and resolutions apply chooser decisions ('ours' = main,
 * 'theirs' = preview). The accept/resolve flows are covered in
 * pageContent.semantic.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub ContentService BEFORE the service module loads, so the import never
// drags in the git-provider/octokit/prisma chain (merge3Blocks is pure).
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {},
}));

const { merge3Blocks, ORDER_CONFLICT_ID } = await import('../pageContent.service.ts');

const block = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text }],
  ...extra,
});
const ids = (blocks: unknown[]) => (blocks as Array<{ id: string }>).map(b => b.id);

// ─── merge3Blocks — fixture matrix ───────────────────────────────────────────

describe('merge3Blocks', () => {
  it('one-side edits are taken (both directions), edits to different blocks both land', () => {
    const base = [block('a', 'one'), block('b', 'two')];
    const ours = [block('a', 'one MAIN'), block('b', 'two')];
    const theirs = [block('a', 'one'), block('b', 'two PREVIEW')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual([block('a', 'one MAIN'), block('b', 'two PREVIEW')]);
    expect(result.autoMerged).toBe(2);
  });

  it('identical edits on both sides merge without conflict', () => {
    const base = [block('a', 'original')];
    const same = [block('a', 'both agree')];

    const result = merge3Blocks(base, same, structuredClone(same));

    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(same);
    expect(result.autoMerged).toBe(1);
  });

  it('both-changed-differently is a content conflict (theirs provisional)', () => {
    const base = [block('a', 'original'), block('b', 'stable')];
    const ours = [block('a', 'main'), block('b', 'stable')];
    const theirs = [block('a', 'preview'), block('b', 'stable')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: 'a',
        index: 0,
        reason: 'content',
        ours: block('a', 'main'),
        theirs: block('a', 'preview'),
        base: block('a', 'original'),
      },
    ]);
    expect(result.merged[0]).toEqual(block('a', 'preview'));
    expect(result.autoMerged).toBe(0);
  });

  it('adds keep their side positions', () => {
    const base = [block('a', 'a'), block('b', 'b')];
    const ours = [block('a', 'a'), block('x', 'added on main'), block('b', 'b')];
    const theirs = [block('a', 'a'), block('b', 'b'), block('y', 'added on preview')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(ids(result.merged)).toEqual(['a', 'x', 'b', 'y']);
  });

  it('the same id added differently on both sides is a both_added conflict', () => {
    const base = [block('a', 'a')];
    const ours = [block('a', 'a'), block('x', 'main add')];
    const theirs = [block('a', 'a'), block('x', 'preview add')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: 'x', reason: 'both_added' });
    expect('base' in result.conflicts[0]).toBe(false);
  });

  it('delete vs unchanged: the delete wins (both directions)', () => {
    const base = [block('a', 'a'), block('b', 'b')];
    const deleted = [block('b', 'b')];
    const untouched = structuredClone(base);

    expect(ids(merge3Blocks(base, deleted, untouched).merged)).toEqual(['b']);
    expect(ids(merge3Blocks(base, untouched, deleted).merged)).toEqual(['b']);
    expect(merge3Blocks(base, deleted, untouched).conflicts).toEqual([]);
  });

  it('delete vs edit is a delete_vs_edit conflict (deleted side absent)', () => {
    const base = [block('a', 'original'), block('b', 'b')];
    const ours = [block('b', 'b')];
    const theirs = [block('a', 'edited on preview'), block('b', 'b')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([
      {
        id: 'a',
        index: 0,
        reason: 'delete_vs_edit',
        theirs: block('a', 'edited on preview'),
        base: block('a', 'original'),
      },
    ]);
    expect(ids(result.merged)).toEqual(['a', 'b']); // edited side provisional
  });

  it('a one-side reorder is taken; both-differently raises the __order__ sentinel', () => {
    const base = [block('a', 'a'), block('b', 'b'), block('c', 'c')];
    const oursReordered = [block('c', 'c'), block('a', 'a'), block('b', 'b')];

    const oneSide = merge3Blocks(base, oursReordered, structuredClone(base));
    expect(oneSide.conflicts).toEqual([]);
    expect(ids(oneSide.merged)).toEqual(['c', 'a', 'b']);

    const theirsReordered = [block('a', 'a'), block('c', 'c'), block('b', 'b')];
    const bothSides = merge3Blocks(base, oursReordered, theirsReordered);
    expect(bothSides.conflicts).toEqual([
      {
        id: ORDER_CONFLICT_ID,
        index: -1,
        reason: 'order',
        base: ['a', 'b', 'c'],
        ours: ['c', 'a', 'b'],
        theirs: ['a', 'c', 'b'],
      },
    ]);
    expect(ids(bothSides.merged)).toEqual(['a', 'c', 'b']); // theirs provisional
  });

  it('children subtrees ride with their top-level block (one-sided child edits merge)', () => {
    const withChild = (text: string) => block('p', 'parent', { children: [block('n', text)] });
    const base = [withChild('child'), block('q', 'q')];
    const ours = [withChild('child'), block('q', 'q EDITED')];
    const theirs = [withChild('child PREVIEW'), block('q', 'q')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual([withChild('child PREVIEW'), block('q', 'q EDITED')]);
  });

  it("both sides editing the same block's children differently is ONE conflict on the block", () => {
    const withChild = (text: string) => block('p', 'parent', { children: [block('n', text)] });
    const base = [withChild('child')];
    const ours = [withChild('child MAIN')];
    const theirs = [withChild('child PREVIEW')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ id: 'p', reason: 'content' });
  });

  it('blocks missing ids align via the deterministic derived ids', () => {
    const noId = { type: 'paragraph', content: [{ type: 'text', text: 'stable' }] };
    const base = [structuredClone(noId), block('b', 'b')];
    const ours = [structuredClone(noId), block('b', 'b MAIN')];
    const theirs = [structuredClone(noId), block('b', 'b')];

    const result = merge3Blocks(base, ours, theirs);

    expect(result.conflicts).toEqual([]);
    // The unedited id-less block aligned across versions (kept once) and the
    // b edit merged.
    expect(result.merged).toHaveLength(2);
    expect((result.merged[1] as { content: Array<{ text: string }> }).content[0].text).toBe(
      'b MAIN'
    );
  });

  it('resolutions apply chooser decisions (content, delete, order)', () => {
    const base = [block('a', 'original'), block('b', 'b'), block('c', 'c')];
    const ours = [block('b', 'b'), block('a', 'main'), block('c', 'c')];
    const theirs = [block('a', 'preview'), block('c', 'c'), block('b', 'b')];

    const result = merge3Blocks(base, ours, theirs, {
      resolutions: { a: 'ours', [ORDER_CONFLICT_ID]: 'theirs' },
    });

    expect(result.conflicts).toEqual([]);
    expect(ids(result.merged)).toEqual(['a', 'c', 'b']);
    expect((result.merged[0] as { content: Array<{ text: string }> }).content[0].text).toBe('main');

    // Delete resolution: choosing the deleting side drops the block.
    const delBase = [block('x', 'original'), block('y', 'y')];
    const delOurs = [block('y', 'y')];
    const delTheirs = [block('x', 'edited'), block('y', 'y')];
    const dropped = merge3Blocks(delBase, delOurs, delTheirs, { resolutions: { x: 'ours' } });
    expect(dropped.conflicts).toEqual([]);
    expect(ids(dropped.merged)).toEqual(['y']);
  });

  it('never mutates its inputs', () => {
    const base = [block('a', 'a')];
    const ours = [block('a', 'a MAIN')];
    const theirs = [block('a', 'a'), block('z', 'z')];
    const snapshots = [structuredClone(base), structuredClone(ours), structuredClone(theirs)];

    merge3Blocks(base, ours, theirs);

    expect([base, ours, theirs]).toEqual(snapshots);
  });
});
