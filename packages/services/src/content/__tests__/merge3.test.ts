/**
 * Unit tests for the shared 3-way merge primitives (merge3.ts):
 * - indexResolutions element-shape validation (F5: malformed choices throw
 *   INVALID_RESOLUTIONS everywhere, never a silent default to a side)
 * - mergeIdSequence3's both-add tiebreak (pins the behavior the F6 comment
 *   documents: theirs' additions land first at a shared anchor)
 * - dedupeMergedTreeIds, the final id-uniqueness sweep both engines run
 */

import { describe, expect, it } from 'vitest';
import {
  dedupeMergedTreeIds,
  indexResolutions,
  mergeIdSequence3,
  PreviewResolutionError,
  type MergeResolution,
} from '../merge3.ts';

describe('indexResolutions — element validation (F5)', () => {
  it('indexes a well-formed array', () => {
    expect(
      indexResolutions([
        { id: 'a', choose: 'ours' },
        { id: '__order__', choose: 'theirs' },
      ])
    ).toEqual({ a: 'ours', __order__: 'theirs' });
  });

  it.each([
    ['bad choose value', [{ id: 'a', choose: 'banana' }]],
    ['missing choose', [{ id: 'a' }]],
    ['empty id', [{ id: '', choose: 'ours' }]],
    ['non-string id', [{ id: 42, choose: 'ours' }]],
    ['null element', [null]],
    ['string element', ['a:ours']],
  ] as Array<[string, unknown[]]>)('throws INVALID_RESOLUTIONS on %s', (_label, resolutions) => {
    let failure: unknown;
    try {
      indexResolutions(resolutions as MergeResolution[]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PreviewResolutionError);
    expect((failure as PreviewResolutionError).code).toBe('INVALID_RESOLUTIONS');
  });

  it('still throws DUPLICATE_RESOLUTIONS on repeated ids', () => {
    let failure: unknown;
    try {
      indexResolutions([
        { id: 'a', choose: 'ours' },
        { id: 'a', choose: 'theirs' },
      ]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'DUPLICATE_RESOLUTIONS', ids: ['a'] });
  });
});

describe('mergeIdSequence3 — both-add tiebreak (F6 comment pin)', () => {
  it("theirs' addition lands FIRST when both sides add at the same anchor of a base backbone", () => {
    const base = ['a', 'b'];
    const ours = ['a', 'o1', 'b'];
    const theirs = ['a', 't1', 'b'];
    const members = new Set(['a', 'b', 'o1', 't1']);

    const result = mergeIdSequence3(base, ours, theirs, members);

    expect(result.conflict).toBe(false);
    if (!result.conflict) {
      // Neither side reordered → base backbone; ours woven first, theirs
      // woven second directly after the shared anchor — ahead of ours'.
      expect(result.order).toEqual(['a', 't1', 'o1', 'b']);
    }
  });
});

describe('dedupeMergedTreeIds', () => {
  const doc = () => [
    { id: 'p', children: [{ id: 'c', text: 'edited' }] },
    { id: 'q', children: [{ id: 'c', text: 'stale' }] },
    { id: 'r' },
  ];

  it('is a no-op on unique ids', () => {
    const nodes = [{ id: 'a' }, { id: 'b', children: [{ id: 'c' }] }];
    expect(dedupeMergedTreeIds(nodes)).toEqual([]);
    expect(nodes).toEqual([{ id: 'a' }, { id: 'b', children: [{ id: 'c' }] }]);
  });

  it('keeps the first occurrence by default and reports the duplicated id', () => {
    const nodes = doc();
    expect(dedupeMergedTreeIds(nodes)).toEqual(['c']);
    expect(nodes).toEqual([
      { id: 'p', children: [{ id: 'c', text: 'edited' }] },
      { id: 'q', children: [] },
      { id: 'r' },
    ]);
  });

  it('prefers the copy inside a conflict-unit subtree even when it comes later', () => {
    const nodes = doc();
    dedupeMergedTreeIds(nodes, new Set(['q']));
    expect(nodes).toEqual([
      { id: 'p', children: [] },
      { id: 'q', children: [{ id: 'c', text: 'stale' }] },
      { id: 'r' },
    ]);
  });

  it('drops a duplicated TOP-LEVEL copy in favor of the conflict copy', () => {
    const nodes = [
      { id: 'p', children: [{ id: 'c', text: 'kept' }] },
      { id: 'c', text: 'stale' },
    ];
    dedupeMergedTreeIds(nodes, new Set(['p']));
    expect(nodes).toEqual([{ id: 'p', children: [{ id: 'c', text: 'kept' }] }]);
  });

  it('dropEmptyChildren removes a children key the sweep emptied (deck shape)', () => {
    const nodes = [
      { id: 'p', children: [{ id: 'c' }] },
      { id: 'q', children: [{ id: 'c' }] },
    ];
    dedupeMergedTreeIds(nodes, new Set(), { dropEmptyChildren: true });
    expect(nodes).toEqual([{ id: 'p', children: [{ id: 'c' }] }, { id: 'q' }]);
  });
});
