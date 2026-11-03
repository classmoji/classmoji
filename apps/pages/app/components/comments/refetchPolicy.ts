/**
 * When the comments list is fetched again. One freshness rule for every
 * background trigger: a list younger than `COMMENTS_FRESH_MS` (from any
 * source: the mount load, a panel open, a focus, the refresh after an own
 * action) is not fetched again on a panel open or a window focus. For an
 * owner or teacher each list reads the live page (collab snapshot or an
 * uncached git read), so these add up.
 *
 * `mount` (the arrival load) and `action` (after the reader's own POST)
 * always fetch, and so does anything while no list is held (never loaded,
 * or the last load failed): freshness only applies to a list on screen.
 */
export const COMMENTS_FRESH_MS = 30_000;

export type RefetchReason = 'mount' | 'action' | 'panel' | 'focus';

export function shouldRefetch({
  reason,
  hasList,
  lastFetchAt,
  now,
}: {
  reason: RefetchReason;
  /** A list is held (the controller's `threads` is not null). */
  hasList: boolean;
  /** When the last successful list was requested; null: never on this page. */
  lastFetchAt: number | null;
  now: number;
}): boolean {
  if (reason === 'mount' || reason === 'action') return true;
  if (!hasList || lastFetchAt === null) return true;
  return now - lastFetchAt >= COMMENTS_FRESH_MS;
}
