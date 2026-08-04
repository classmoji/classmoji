/**
 * blockOpsDiff.ts — pure diff-at-save helper for the pages editor.
 *
 * Diffs the editor's current BlockNote document against the baseline snapshot
 * it mounted from (loader content / merged-document adoption / last
 * successful save) and emits the block operations the server replays against
 * the SAME base (`theirs = applyBlockOps(base, ops)` in
 * pageContent.service). Untouched blocks never leave the client, and
 * concurrent saves to different blocks auto-merge by construction.
 *
 * The unit is the TOP-LEVEL block: nested children ride inside their
 * top-level block, so a changed child = one update op on its top-level
 * parent — matching the merge engine's unit.
 *
 * `null` = no trustworthy diff — the caller falls back to the whole-document
 * save (the 7.5 path, which needs no baseline). Returned for:
 * - a missing/non-array baseline or current document,
 * - a top-level block without a usable string id,
 * - duplicate ids anywhere in either tree (id-addressed ops would be
 *   ambiguous server-side),
 * - ids that change scope between the docs (top-level ⇄ nested — the op
 *   vocabulary cannot express a cross-scope move without id churn),
 * - reorders moving more than MAX_MOVES blocks (a whole-document save beats
 *   a long, fragile move script).
 *
 * No React/BlockNote imports — the Playwright runner unit-tests this module
 * directly (tests/unit/block-ops-diff.spec.ts) without a browser.
 */

// ── Op vocabulary (client-side twin of pageContent.service's BlockOp) ────────

export type BlockPosition = { after: string } | { at: 'start' | 'end' };

export type BlockOp =
  | { op: 'update'; id: string; block: unknown }
  | { op: 'insert'; blocks: unknown[]; position: BlockPosition }
  | { op: 'move'; id: string; position: BlockPosition }
  | { op: 'delete'; id: string };

/** Reorders that move more than this many blocks fall back to a whole-doc save. */
export const MAX_MOVES = 3;

interface BlockNode {
  id?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

// ── Canonical JSON (service twin) ────────────────────────────────────────────

/**
 * Deterministic serialization with object keys sorted at every level, so two
 * structurally identical blocks compare equal regardless of key insertion
 * order (the baseline came from parsed file JSON, the current doc from the
 * live editor).
 */
function canonicalJson(value: unknown): string {
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

// ── Document analysis ────────────────────────────────────────────────────────

interface DocInfo {
  /** Top-level block ids in document order. */
  topIds: string[];
  /** Ids that live nested inside some block's children subtree. */
  nested: Set<string>;
}

/**
 * Collect a document's top-level ids and nested ids. `null` = the document
 * can't be diffed safely: a top-level entry that isn't an object, a top-level
 * block without a non-empty string id, or any id appearing twice in the tree.
 * (Nested blocks without ids are fine — they ride inside their parent.)
 */
function analyzeDoc(doc: unknown[]): DocInfo | null {
  const topIds: string[] = [];
  const all = new Set<string>();
  const nested = new Set<string>();
  let duplicate = false;

  const walkChildren = (children: unknown): void => {
    if (duplicate || !Array.isArray(children)) return;
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      const id = (child as BlockNode).id;
      if (typeof id === 'string' && id) {
        if (all.has(id)) {
          duplicate = true;
          return;
        }
        all.add(id);
        nested.add(id);
      }
      walkChildren((child as BlockNode).children);
      if (duplicate) return;
    }
  };

  for (const block of doc) {
    if (!block || typeof block !== 'object') return null;
    const id = (block as BlockNode).id;
    if (typeof id !== 'string' || !id) return null;
    if (all.has(id)) return null;
    all.add(id);
    topIds.push(id);
    walkChildren((block as BlockNode).children);
    if (duplicate) return null;
  }
  return { topIds, nested };
}

/** Indices of one longest strictly-increasing subsequence of `seq` (O(n²) DP). */
function lisIndices(seq: number[]): number[] {
  const n = seq.length;
  if (n === 0) return [];
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (len[i] > len[best]) best = i;
  }
  const out: number[] = [];
  for (let k = best; k !== -1; k = prev[k]) out.push(k);
  return out.reverse();
}

// ── The diff ─────────────────────────────────────────────────────────────────

/**
 * Diff `current` against `baseline` into a minimal op script, or `null` when
 * no trustworthy diff exists (see module doc) — the caller then falls back to
 * the whole-document save.
 *
 * Op order matters for server-side replay and is fixed as
 * updates → deletes → moves → inserts:
 * - updates address common ids in place (position-independent);
 * - deletes leave only the survivors;
 * - moves put the survivors in their final relative order (minimal set via
 *   LIS: only blocks OFF the longest stable subsequence move, each placed
 *   `{ after: <its final predecessor> }` in final order — every anchor is a
 *   survivor already in position);
 * - inserts splice each consecutive run of new blocks after its final
 *   left-hand neighbor (a survivor, or a block from an earlier insert run).
 *
 * An empty array means the documents are canonically identical — nothing to
 * save.
 */
export function diffBlockOps(baseline: unknown, current: unknown): BlockOp[] | null {
  if (!Array.isArray(baseline) || !Array.isArray(current)) return null;

  const base = analyzeDoc(baseline);
  const cur = analyzeDoc(current);
  if (!base || !cur) return null;

  // Cross-scope ids (top-level in one doc, nested in the other): a whole-doc
  // save lets the merge engine's cross-scope handling deal with it.
  for (const id of cur.topIds) {
    if (base.nested.has(id)) return null;
  }
  for (const id of base.topIds) {
    if (cur.nested.has(id)) return null;
  }

  const baseSet = new Set(base.topIds);
  const curSet = new Set(cur.topIds);
  const ops: BlockOp[] = [];

  // 1. update — common ids whose block (whole subtree) changed canonically.
  const baseBlockById = new Map<string, unknown>();
  base.topIds.forEach((id, index) => baseBlockById.set(id, baseline[index]));
  cur.topIds.forEach((id, index) => {
    if (!baseSet.has(id)) return;
    if (canonicalJson(baseBlockById.get(id)) !== canonicalJson(current[index])) {
      ops.push({ op: 'update', id, block: current[index] });
    }
  });

  // 2. delete — base ids gone from current.
  for (const id of base.topIds) {
    if (!curSet.has(id)) ops.push({ op: 'delete', id });
  }

  // 3. move — survivors whose relative order changed (minimal set via LIS).
  const remaining = base.topIds.filter(id => curSet.has(id));
  const commonCur = cur.topIds.filter(id => baseSet.has(id));
  const basePos = new Map<string, number>();
  remaining.forEach((id, index) => basePos.set(id, index));
  const seq = commonCur.map(id => basePos.get(id)!);
  const stable = new Set(lisIndices(seq).map(index => commonCur[index]));
  const movedCount = commonCur.length - stable.size;
  if (movedCount > MAX_MOVES) return null;
  commonCur.forEach((id, index) => {
    if (stable.has(id)) return;
    ops.push({
      op: 'move',
      id,
      position: index === 0 ? { at: 'start' } : { after: commonCur[index - 1] },
    });
  });

  // 4. insert — consecutive runs of new blocks, left-to-right.
  let i = 0;
  while (i < cur.topIds.length) {
    if (baseSet.has(cur.topIds[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < cur.topIds.length && !baseSet.has(cur.topIds[j])) j++;
    ops.push({
      op: 'insert',
      blocks: current.slice(i, j),
      position: i === 0 ? { at: 'start' } : { after: cur.topIds[i - 1] },
    });
    i = j;
  }

  return ops;
}
