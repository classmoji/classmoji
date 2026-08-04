/**
 * merge3.ts — shared primitives for the semantic 3-way content merge
 * (content-tools plan §3b, Phase 7).
 *
 * Pure functions only: no service imports, no network, no database. Used by
 * the deck merge engine (slides/deckMerge.ts) and the page block merge engine
 * (classmoji/pageContent.service.ts merge3Blocks).
 */

// ─── Resolution types ────────────────────────────────────────────────────────

/** A per-conflict choice: `ours` = the live (main) side, `theirs` = the preview side. */
export type MergeChoice = 'ours' | 'theirs';

/** One chooser decision, keyed by the conflict id from a prior conflict report. */
export interface MergeResolution {
  id: string;
  choose: MergeChoice;
}

/**
 * Typed failure for resolvePreviewConflicts: the supplied resolutions do not
 * exactly cover the current conflict set (or there is nothing to resolve).
 * Carries the offending ids so tools can name them.
 *
 * Additional codes:
 * - `INVALID_RESOLUTIONS` — a resolution element is malformed (id not a
 *   non-empty string, or choose not 'ours'/'theirs'). Validated centrally in
 *   indexResolutions so a malformed choice can never silently default.
 * - `CONTENT_CONFLICT` — the caller pinned the resolution to a conflict
 *   report (expected ours/theirs shas) and the content moved since; the
 *   report is stale — re-run accept for a fresh one.
 * - `MAIN_CONTENT_MISSING` — main's content file was deleted, so there is no
 *   sha to CAS the merge commit on; discard the preview or re-apply it.
 */
export class PreviewResolutionError extends Error {
  code:
    | 'NO_PREVIEW'
    | 'NOTHING_TO_RESOLVE'
    | 'UNRESOLVED_CONFLICTS'
    | 'UNKNOWN_RESOLUTIONS'
    | 'DUPLICATE_RESOLUTIONS'
    | 'INVALID_RESOLUTIONS'
    | 'CONTENT_CONFLICT'
    | 'MAIN_CONTENT_MISSING';
  ids: string[];

  constructor(message: string, code: PreviewResolutionError['code'], ids: string[] = []) {
    super(message);
    this.name = 'PreviewResolutionError';
    this.code = code;
    this.ids = ids;
  }
}

/**
 * Validate a resolutions array (well-formed elements, no duplicate ids) and
 * index it by conflict id. Every element must be `{id: non-empty string,
 * choose: 'ours' | 'theirs'}` — anything else throws INVALID_RESOLUTIONS
 * (never a silent default to one side). Duplicates throw
 * DUPLICATE_RESOLUTIONS.
 */
export function indexResolutions(resolutions: MergeResolution[]): Record<string, MergeChoice> {
  const map: Record<string, MergeChoice> = {};
  const dupes: string[] = [];
  for (const entry of resolutions) {
    const { id, choose } = (entry ?? {}) as { id?: unknown; choose?: unknown };
    if (typeof id !== 'string' || id.length === 0 || (choose !== 'ours' && choose !== 'theirs')) {
      throw new PreviewResolutionError(
        "Malformed resolution — every element must be {id: non-empty string, choose: 'ours'|'theirs'}",
        'INVALID_RESOLUTIONS',
        typeof id === 'string' && id ? [id] : []
      );
    }
    if (id in map) dupes.push(id);
    map[id] = choose;
  }
  if (dupes.length > 0) {
    throw new PreviewResolutionError(
      `Duplicate resolution ids: ${dupes.join(', ')} — pass each conflict id exactly once`,
      'DUPLICATE_RESOLUTIONS',
      dupes
    );
  }
  return map;
}

// ─── Canonical JSON (order-insensitive deep comparison) ──────────────────────

/**
 * Deterministic serialization with object keys sorted at every level, so
 * comparisons are stable regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

// ─── 3-way id-sequence merge ─────────────────────────────────────────────────

export type SequenceMerge3Result =
  | { conflict: false; order: string[] }
  | {
      conflict: true;
      base: string[];
      ours: string[];
      theirs: string[];
      /** Theirs-backboned order, used while the conflict is pending resolution. */
      provisional: string[];
    };

const restrictTo = (seq: string[], keep: ReadonlySet<string>): string[] =>
  seq.filter(id => keep.has(id));

const sameSeq = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function intersect(a: string[], b: string[]): Set<string> {
  const bSet = new Set(b);
  return new Set(a.filter(id => bSet.has(id)));
}

/**
 * Weave `members` from sideSeq that are missing from `result` into `result`,
 * each inserted directly after the nearest preceding sideSeq element already
 * present (runs of consecutive additions keep their side order; additions with
 * no preceding anchor land at the start).
 */
function weave(result: string[], sideSeq: string[], members: ReadonlySet<string>): void {
  let lastIdx = -1;
  for (const id of sideSeq) {
    const existing = result.indexOf(id);
    if (existing !== -1) {
      lastIdx = existing;
      continue;
    }
    if (!members.has(id)) continue;
    result.splice(lastIdx + 1, 0, id);
    lastIdx += 1;
  }
}

/**
 * 3-way merge of an id sequence (one document "scope": the top level, or one
 * stack's children).
 *
 * Reordering is detected on the ids each side SHARES with base (additions and
 * deletions never count as a reorder). One side reordered → its order is the
 * backbone; both reordered identically → that order; both reordered
 * differently → conflict (unless `resolution` picks a backbone). The final
 * sequence contains exactly `members`, with each side's additions woven in at
 * their side-relative positions (runs of consecutive additions keep their
 * side order; when both sides add at the same anchor of a base backbone,
 * theirs' additions land first — ours is woven before theirs, so the later
 * theirs weave inserts directly after the shared anchor, ahead of ours').
 *
 * @param members - the ids that must appear in the output (the surviving units
 *   assigned to this scope by the unit-level merge).
 * @param resolution - optional pre-resolved backbone for an order conflict.
 */
export function mergeIdSequence3(
  base: string[],
  ours: string[],
  theirs: string[],
  members: ReadonlySet<string>,
  resolution?: MergeChoice
): SequenceMerge3Result {
  const oursShared = intersect(base, ours);
  const theirsShared = intersect(base, theirs);
  const oursReordered = !sameSeq(restrictTo(base, oursShared), restrictTo(ours, oursShared));
  const theirsReordered = !sameSeq(
    restrictTo(base, theirsShared),
    restrictTo(theirs, theirsShared)
  );

  const bothShared = intersect(ours, theirs);
  const agreeRelative = sameSeq(restrictTo(ours, bothShared), restrictTo(theirs, bothShared));

  const build = (backbone: 'base' | 'ours' | 'theirs'): string[] => {
    const spine = backbone === 'base' ? base : backbone === 'ours' ? ours : theirs;
    const result = restrictTo(spine, members);
    weave(result, ours, members);
    weave(result, theirs, members);
    return result;
  };

  const genuineOrderConflict = oursReordered && theirsReordered && !agreeRelative;
  if (genuineOrderConflict && !resolution) {
    return {
      conflict: true,
      base: [...base],
      ours: [...ours],
      theirs: [...theirs],
      provisional: build('theirs'),
    };
  }

  const backbone: 'base' | 'ours' | 'theirs' = genuineOrderConflict
    ? (resolution as MergeChoice)
    : oursReordered
      ? 'ours'
      : theirsReordered
        ? 'theirs'
        : 'base';
  return { conflict: false, order: build(backbone) };
}

// ─── Merged-document id uniqueness (final safety sweep) ──────────────────────

interface DedupeTreeNode {
  id?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

/**
 * Enforce id uniqueness on an assembled merged document — the final assertion
 * both merge engines run before returning `merged`. Duplicate ids should be
 * unreachable after the cross-scope-move handling, but deeply-nested
 * cross-parent moves (an id nested under different parents on each side, both
 * parents kept) can still smuggle two copies in.
 *
 * For each duplicated id, ONE copy is kept: the first copy that sits inside a
 * conflict unit's subtree (`preferredRoots` — that copy is what the chooser
 * card showed / the resolution produced), else the first in document order.
 * Every other copy is removed, subtree included (it is by definition a stale
 * duplicate). Mutates `nodes` in place; returns the duplicated ids for
 * logging/telemetry.
 *
 * @param opts.dropEmptyChildren - delete a `children` key emptied by the
 *   sweep (deck documents omit empty children; BlockNote keeps `[]`).
 */
export function dedupeMergedTreeIds(
  nodes: unknown[],
  preferredRoots: ReadonlySet<string> = new Set(),
  opts: { dropEmptyChildren?: boolean } = {}
): string[] {
  const byId = new Map<string, Array<{ node: DedupeTreeNode; preferred: boolean }>>();

  const scan = (list: DedupeTreeNode[], underPreferred: boolean): void => {
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const id = typeof node.id === 'string' && node.id ? node.id : null;
      const preferred = underPreferred || (id != null && preferredRoots.has(id));
      if (id != null) {
        const bucket = byId.get(id) ?? [];
        bucket.push({ node, preferred });
        byId.set(id, bucket);
      }
      if (Array.isArray(node.children)) {
        scan(node.children as DedupeTreeNode[], preferred);
      }
    }
  };
  scan(nodes as DedupeTreeNode[], false);

  const toDrop = new Set<DedupeTreeNode>();
  const duplicated: string[] = [];
  for (const [id, bucket] of byId) {
    if (bucket.length < 2) continue;
    duplicated.push(id);
    const winner = bucket.find(occurrence => occurrence.preferred) ?? bucket[0];
    for (const occurrence of bucket) {
      if (occurrence !== winner) toDrop.add(occurrence.node);
    }
  }
  if (toDrop.size === 0) return [];

  const prune = (list: DedupeTreeNode[]): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i];
      if (node && typeof node === 'object' && toDrop.has(node)) {
        list.splice(i, 1);
        continue;
      }
      if (Array.isArray(node?.children)) {
        prune(node.children as DedupeTreeNode[]);
        if (opts.dropEmptyChildren && (node.children as unknown[]).length === 0) {
          delete node.children;
        }
      }
    }
  };
  prune(nodes as DedupeTreeNode[]);

  return duplicated;
}
