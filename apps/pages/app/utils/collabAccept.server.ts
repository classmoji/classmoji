/**
 * Accepting a preview into a LIVE page: the pure plan.
 *
 * In a classroom that edits pages live, main is only the last checkpoint —
 * the page is the live document. So an accept is not a git merge into main:
 * it is a three-way merge of the block documents (base = the preview's
 * merge-base, ours = the live document, theirs = the preview), turned into
 * id-aware block ops the collab server applies to the live document. People
 * typing at that moment keep their typing: only the blocks the merge changes
 * are touched.
 *
 * The merge engine is injected (it lives in @classmoji/services, which the
 * unit suite does not load), so this stays testable on its own
 * (tests/unit/collab-accept.spec.ts).
 */

import { diffBlockOps, type BlockOp } from '~/components/editor/blockOpsDiff.ts';

export type MergeChoice = 'ours' | 'theirs';

export interface MergeConflictUnit {
  id: string;
  [key: string]: unknown;
}

export interface MergeResult {
  merged: unknown[];
  conflicts: MergeConflictUnit[];
  autoMerged: number;
}

export type MergeFn = (
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  opts?: { resolutions?: Record<string, MergeChoice> }
) => MergeResult;

export interface CoverValue {
  url: string;
  position: number;
}

/** A live-document op: the editor diff's vocabulary plus `replace_all`. */
export type LiveBlockOp = BlockOp | { op: 'replace_all'; blocks: unknown[] };

export type CollabAcceptPlan =
  | { kind: 'conflict'; units: MergeConflictUnit[]; autoMerged: number }
  | {
      kind: 'apply';
      ops: LiveBlockOp[];
      /** Set only when the cover must change; `value: null` removes it. */
      cover: { value: CoverValue | null } | null;
      autoMerged: number;
    };

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The cover's three-way: a change on the preview side wins, anything else
 * keeps the live cover (the same rule as the git accept).
 */
export function mergeCoverValue(
  base: CoverValue | null,
  ours: CoverValue | null,
  theirs: CoverValue | null
): CoverValue | null {
  const theirsChanged = !sameJson(theirs, base);
  const oursChanged = !sameJson(ours, base);
  if (theirsChanged && !oursChanged) return theirs;
  return ours;
}

/** Resolutions as the merge engine takes them; malformed entries are dropped. */
export function resolutionMap(
  resolutions: Array<{ id?: unknown; choose?: unknown }> | null | undefined
): Record<string, MergeChoice> {
  const map: Record<string, MergeChoice> = {};
  for (const entry of resolutions ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (entry.choose === 'ours' || entry.choose === 'theirs') map[entry.id] = entry.choose;
  }
  return map;
}

/**
 * Merge, then express the result as ops against the live document. Conflicts
 * (after any resolutions) come back as a report for the chooser. A merge the
 * op diff cannot express (a block moved between nesting levels, duplicated
 * ids) is sent as one `replace_all`, which the collab server still applies
 * id-aware.
 */
export function planCollabAccept(
  {
    base,
    ours,
    theirs,
    baseCover,
    oursCover,
    theirsCover,
    resolutions,
  }: {
    base: unknown[];
    ours: unknown[];
    theirs: unknown[];
    baseCover: CoverValue | null;
    oursCover: CoverValue | null;
    theirsCover: CoverValue | null;
    resolutions?: Record<string, MergeChoice>;
  },
  merge: MergeFn
): CollabAcceptPlan {
  const hasResolutions = resolutions && Object.keys(resolutions).length > 0;
  const result = merge(base, ours, theirs, hasResolutions ? { resolutions } : {});
  if (result.conflicts.length > 0) {
    return { kind: 'conflict', units: result.conflicts, autoMerged: result.autoMerged };
  }
  const diff = diffBlockOps(ours, result.merged, { maxMoves: Infinity });
  const ops: LiveBlockOp[] = diff ?? [{ op: 'replace_all', blocks: result.merged }];
  const coverAfter = mergeCoverValue(baseCover, oursCover, theirsCover);
  const cover = sameJson(coverAfter, oursCover) ? null : { value: coverAfter };
  return { kind: 'apply', ops, cover, autoMerged: result.autoMerged };
}
