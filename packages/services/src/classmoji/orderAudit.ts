/**
 * What a reorder's audit row records: which rows moved and where they landed,
 * not the whole list. A drag moves one row and shifts the others by a place,
 * so "moved" is the rows that left their place among the others: the rows
 * outside a longest run that kept its relative order (a longest increasing
 * subsequence of their previous places). One drag is one moved row, however
 * long the list.
 */

/** How many moved rows a reorder's row names; past it only the count. */
export const REORDER_AUDIT_MAX_MOVED = 20;

export type ReorderKind = 'ASSIGNMENTS' | 'ITEMS' | 'MODULES';

export interface ReorderAuditData {
  [key: string]: unknown;
  kind: ReorderKind;
  /** How many rows the list holds. */
  count: number;
  /** How many rows moved. */
  moved_count: number;
  /** The moved rows (at most REORDER_AUDIT_MAX_MOVED), each with its new and old place. */
  moved: Array<{ id: string; position: number; previous_position: number }>;
}

/**
 * The indexes (into `ranks`) of one longest strictly increasing subsequence
 * of `ranks`, in order. O(n log n).
 */
function longestIncreasing(ranks: number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array(ranks.length).fill(-1);
  for (let i = 0; i < ranks.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranks[tails[mid]] < ranks[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const kept = new Set<number>();
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (at !== -1) {
    kept.add(at);
    at = previous[at];
  }
  return kept;
}

/**
 * The row of a reorder from `before` (the list's ids in the order it showed
 * before the write) to `ordered` (the order written), or null when the order
 * did not change. Positions are indexes in each list.
 */
export function reorderAuditData(
  kind: ReorderKind,
  before: readonly string[],
  ordered: readonly string[]
): ReorderAuditData | null {
  const previousIndex = new Map(before.map((id, index) => [id, index]));
  const ranks = ordered.map(id => previousIndex.get(id) ?? -1);
  const kept = longestIncreasing(ranks);
  const moved = ordered
    .map((id, position) => ({ id, position, previous_position: ranks[position] }))
    .filter((_, position) => !kept.has(position));
  if (moved.length === 0) return null;
  return {
    kind,
    count: ordered.length,
    moved_count: moved.length,
    moved: moved.slice(0, REORDER_AUDIT_MAX_MOVED),
  };
}
