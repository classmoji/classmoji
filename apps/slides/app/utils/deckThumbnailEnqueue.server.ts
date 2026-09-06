/**
 * The ON-VIEW enqueue: a deck the index drew a placeholder for asks to be
 * rendered.
 *
 * The ordinary way a deck gets its card image is a SAVE — `recordDeckFiles` and
 * its siblings enqueue `deck-thumbnail-render` on the way out. That covers every
 * deck anyone edits from here on and nothing else: a deck last saved before this
 * shipped, one whose render failed, one whose classroom was created by an
 * import. The backfill script fills those in as a one-shot; this is what keeps
 * the index self-healing afterwards without a sweep nobody asked for.
 *
 * It is deliberately the WEAKEST possible trigger:
 *
 *   - it fires only for a deck with no stored thumbnail, and only when the card
 *     is actually scrolled into view;
 *   - it is capped per deck per process (below) and per page load (in the route),
 *     so a viewer holding refresh cannot spend the render budget;
 *   - it enqueues under the same idempotency key the save path uses, so a
 *     backfill run and an on-view request for the same deck collapse into one;
 *   - and it can do nothing at all — no thumbnail, same placeholder, no error
 *     shown. Nobody is waiting on it.
 */

import { ClassmojiService } from '@classmoji/services';

/**
 * At most one enqueue per deck per ten minutes, per process.
 *
 * Long enough that a render (~6s of browser plus a queue that meters four at a
 * time platform-wide) has finished and committed by the time the window
 * reopens, so a second request means the first genuinely did not produce a
 * thumbnail rather than that it has not landed yet.
 */
export const ENQUEUE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Per-deck last-attempt clock: in-process, unbounded in principle and pruned in
 * practice, and it does not have to be shared. A second instance getting its
 * own window costs one extra enqueue, which the task's own skip-if-unchanged
 * check throws away for free.
 */
const lastEnqueuedAt = new Map<string, number>();

export type EnqueueOutcome = 'enqueued' | 'rate-limited' | 'failed';

/**
 * Has this deck been asked for recently enough that asking again is noise?
 *
 * Two clocks, and either one closes the window: what THIS process last
 * enqueued, and what the DATABASE says was last rendered. The second is what
 * survives a deploy — a fresh process has an empty map, and without the stored
 * timestamp the first index load after every deploy would re-enqueue every deck
 * that has no thumbnail, forever, for exactly the decks whose renders keep
 * failing.
 */
export function isWithinEnqueueWindow(
  slideId: string,
  renderedAt: Date | string | null | undefined,
  now: number = Date.now()
): boolean {
  const last = lastEnqueuedAt.get(slideId);
  if (last !== undefined && now - last < ENQUEUE_WINDOW_MS) return true;

  if (renderedAt) {
    const at = renderedAt instanceof Date ? renderedAt.getTime() : Date.parse(String(renderedAt));
    if (Number.isFinite(at) && now - at < ENQUEUE_WINDOW_MS) return true;
  }

  return false;
}

/** Forget every deck whose window has closed. Called on the way in, not on a timer. */
function prune(now: number): void {
  for (const [slideId, at] of lastEnqueuedAt) {
    if (now - at >= ENQUEUE_WINDOW_MS) lastEnqueuedAt.delete(slideId);
  }
}

/**
 * Ask for this deck's thumbnail, unless it has been asked for recently.
 *
 * Never throws: the caller is a fetcher behind a placeholder card, and the only
 * thing a failure changes is that the placeholder stays.
 */
export async function enqueueDeckThumbnail(
  slide: { id: string; classroom_id?: string; thumbnail_rendered_at?: Date | string | null },
  now: number = Date.now()
): Promise<EnqueueOutcome> {
  prune(now);

  if (isWithinEnqueueWindow(slide.id, slide.thumbnail_rendered_at, now)) return 'rate-limited';

  // Stamped BEFORE the call, so a slow enqueue still closes the window: a deck
  // must not be re-asked for by every card that scrolls past it.
  lastEnqueuedAt.set(slide.id, now);

  try {
    // The same helper the save paths call, so an on-view request and a save
    // land under the same `deck-thumb:{slideId}` idempotency key and collapse
    // into one run. It swallows its own failures and never rejects; the catch
    // below is belt-and-braces, not a second policy.
    await ClassmojiService.deckThumbnail.enqueueDeckThumbnail(slide.id, slide.classroom_id);
    return 'enqueued';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[slides] Thumbnail enqueue failed for ${slide.id}:`, message);
    return 'failed';
  }
}

/** Test seam: forget every window. Never called in production. */
export function resetEnqueueWindows(): void {
  lastEnqueuedAt.clear();
}
