/**
 * deckThumbnail.service.ts — the enqueue half of deck thumbnails.
 *
 * Kept out of `deckThumbnail.contract.ts` on purpose. That file is imported by
 * the slides render route AND by the render task, and it must stay free of a
 * Trigger.dev dependency: a route that renders one slide has no business
 * pulling a job-queue client into its module graph.
 *
 * This file is the opposite — it exists only to put a run on the queue, and it
 * is imported only by the deck WRITE paths.
 *
 * ## Why the raw string id
 *
 * `@classmoji/services` cannot import `@classmoji/tasks`: tasks already depends
 * on services, and the reverse edge would close the cycle. So the task is named
 * by its string id, exactly as `staff.service.ts` and `notification.service.ts`
 * name theirs. The cost is that a renamed task id fails at runtime rather than
 * at build; the id is a constant here so there is one place to change.
 */
import { tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';

/** The task's own `id` in `packages/tasks/src/workflows/deckThumbnail.ts`. */
const DECK_THUMBNAIL_TASK_ID = 'deck-thumbnail-render';

/**
 * How long a save waits before its deck is screenshotted.
 *
 * There is no autosave in the deck editor — `handleSave` submits on an explicit
 * click — so saves are already sparse, and this is not defending against a
 * keystroke storm. What it coalesces is the human pattern of save, look, tweak,
 * save again within a minute: three saves that would otherwise commit three
 * WebPs into the content repo, of which only the last is the picture anyone
 * ends up seeing.
 *
 * A minute is also short enough that a single deliberate save has its card
 * updated before the author has finished navigating back to the index.
 */
const DEBOUNCE_DELAY = '60s';

/**
 * How long the idempotency key holds, and why it is LONGER than the delay.
 *
 * The key suppresses a second enqueue for the same deck while one is already
 * pending. If it expired exactly at 60s it would expire at the very moment the
 * first run starts — and a save landing a tick later would enqueue a second run
 * that renders the same document the first one is rendering right now.
 *
 * The extra 30s covers that overlap: the window closes only once the first run
 * has had a chance to finish, and by then its own sha check makes a duplicate a
 * no-op anyway. Two guards for the same thing, because this one is cheap and
 * the other one costs a database read inside a booted browser.
 */
const IDEMPOTENCY_TTL = '90s';

/**
 * Ask for one deck's thumbnail to be re-rendered. Fire and forget.
 *
 * ## The contract, which matches `warmContentText`'s exactly
 *
 * NEVER REJECTS, and is called WITHOUT `await` from the save paths. A save that
 * has committed its files and written its asset rows is finished; whether a
 * picture of it gets refreshed is not the saver's problem, and a Trigger.dev
 * outage must not turn a successful save into an error on somebody's screen.
 * Every failure is swallowed here rather than at the call sites, so no call
 * site can forget to.
 *
 * ## The loop guard
 *
 * This function is the ONLY way a render is enqueued, and it lives only in deck
 * write paths. The task itself commits through `ContentService.uploadBatch` and
 * `recordContentAsset` directly — never through `recordDeckFiles` — so the WebP
 * it writes cannot come back around to here. See the header of
 * `packages/tasks/src/workflows/deckThumbnail.ts`, and the structural test that
 * asserts it.
 *
 * ## Coalescing
 *
 * `delay` + `idempotencyKey` together mean N saves of one deck inside 90
 * seconds produce ONE run. `concurrencyKey` is the classroom, so a classroom
 * importing forty decks cannot monopolise the task's four browser slots and
 * stall every other classroom's saves behind it.
 *
 * @param slideId     the deck to render. The task loads everything else itself,
 *                    deliberately: a payload carrying a content path or a sha
 *                    would be a snapshot taken 60 seconds before the render.
 * @param classroomId the deck's classroom, used only as the concurrency key. A
 *                    missing one costs fair queueing, not correctness, so it is
 *                    optional rather than a reason to skip the enqueue.
 * @param opts        `force` renders even when the deck's `index.html` has not
 *                    moved. A SAVE never needs it — an unchanged document makes
 *                    the same picture — but a THEME edit changes how every deck
 *                    in a classroom looks without touching a byte of any of them.
 */
export async function enqueueDeckThumbnail(
  slideId: string | null | undefined,
  classroomId?: string | null,
  opts: { force?: boolean } = {}
): Promise<void> {
  if (!slideId) return;

  try {
    await tasks.trigger(
      DECK_THUMBNAIL_TASK_ID,
      { slideId, ...(opts.force ? { force: true } : {}) },
      {
        delay: DEBOUNCE_DELAY,
        idempotencyKey: `deck-thumb:${slideId}`,
        idempotencyKeyTTL: IDEMPOTENCY_TTL,
        ...(classroomId ? { concurrencyKey: classroomId } : {}),
      }
    );
  } catch (error) {
    // Debug, not warn: a missed enqueue costs a stale card until the next save
    // or the next backfill, and the index draws its own placeholder for a deck
    // that has no thumbnail at all. Logging it where operators are told to look
    // would turn a cosmetic refresh into an alarm.
    // eslint-disable-next-line no-console
    console.debug(
      `[deckThumbnail] Could not enqueue a render for slide ${slideId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Re-render every deck in one classroom. Fire and forget, like its sibling.
 *
 * ## What this is for
 *
 * A THEME edit — a custom-theme CSS write, a snippet, a `saveTheme` — changes
 * how every deck in the classroom LOOKS without changing a byte of any deck's
 * own files. The render task's idempotence check asks "has this deck's
 * `index.html` moved?", which is the right question for a save and exactly the
 * wrong one here: it would answer "no" for every deck and the classroom would
 * keep its old cards until someone happened to edit each one. Hence `force`.
 *
 * ## Why it does not filter by theme
 *
 * `themeName` is accepted and logged, and it does NOT narrow the set. A deck's
 * theme lives inside its own `index.html` (`data-theme="shared:<name>"`), not in
 * a column — so narrowing would mean fetching and parsing every deck's document
 * to decide which ones to skip, which costs more than the renders it saves. The
 * task's own `queue: { concurrencyLimit: 4 }` meters the result, and a deck on a
 * different theme costs one render that produces a near-identical picture.
 *
 * ## Contract
 *
 * NEVER REJECTS and is called WITHOUT `await`, exactly like `enqueueDeck-
 * Thumbnail`. A theme save is finished when its files are committed; whether the
 * cards catch up is not the saver's problem, and it must never be able to fail
 * somebody's save. Each deck goes out under the same `deck-thumb:{slideId}` key,
 * so a theme edit and a deck save inside the window collapse into one run.
 */
export async function enqueueClassroomThumbnails(
  classroomId: string | null | undefined,
  opts: { themeName?: string | null; force?: boolean } = {}
): Promise<void> {
  if (!classroomId) return;

  try {
    const slides = await getPrisma().slide.findMany({
      where: { classroom_id: classroomId },
      select: { id: true },
    });

    // Sequential rather than `Promise.all`: this is background work behind a
    // save that has already returned, and a classroom with forty decks has no
    // reason to open forty concurrent trigger requests to do it.
    for (const slide of slides) {
      await enqueueDeckThumbnail(slide.id, classroomId, { force: opts.force });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.debug(
      `[deckThumbnail] Could not enqueue renders for classroom ${classroomId}${
        opts.themeName ? ` after a "${opts.themeName}" theme edit` : ''
      }:`,
      error instanceof Error ? error.message : error
    );
  }
}
