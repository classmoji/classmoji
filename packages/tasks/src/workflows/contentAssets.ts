import { task, schedules, logger } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';

/**
 * Keep a classroom's content-asset map in step with its content repo.
 *
 * The map is a CACHE of the repo tree — path → git SHA — and everything in it
 * is derivable from GitHub. That shapes both tasks here: neither repairs
 * anything by hand, and both are safe to run again for the same push.
 *
 * ── Why a task rather than doing it in the webhook ─────────────────────────
 * A push webhook has to be answered fast, and a sync is one-to-many GitHub
 * calls plus a transaction. hook-station therefore does the cheap part —
 * decide the push is for a content repo, aggregate the changed paths — and
 * hands the work here.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * `syncContentAssets` is mark-and-sweep, not a diff: every row it writes
 * carries the same `synced_at` stamp, and a full run deletes whatever is left
 * below it. Running the same payload twice therefore lands on exactly the same
 * rows the first run produced. That matters because Trigger retries, and
 * because GitHub redelivers.
 */

/**
 * A push that isn't a plain fast-forward, or one whose commit list GitHub
 * truncated, can't be trusted to name every changed path — so those escalate
 * to a full tree read rather than applying an incomplete diff.
 */
interface ContentAssetsSyncPayload {
  classroomId: string;
  reason: 'push' | 'ttl' | 'manual' | 'bootstrap';
  changes?: { added: string[]; modified: string[]; removed: string[] };
  /** Non-fast-forward push (force-push, branch reset) → the diff is meaningless. */
  forced?: boolean;
  /** False when the push payload's `commits[]` was capped (GitHub sends at most 20). */
  complete?: boolean;
  /**
   * The commit the push built on. A push whose parent is not the commit the map
   * is level with means an earlier delivery was lost, and the sync escalates to
   * a full tree read rather than applying a diff against a state it never had.
   */
  before?: string;
  /** The commit the push landed — recorded as the map's new level. */
  after?: string;
}

export const contentAssetsSyncTask = task({
  id: 'content-assets-sync',
  /**
   * ONE sync per classroom at a time.
   *
   * The map is only self-correcting if the runs that build it are ordered.
   * Two deliveries for one repo arriving together can apply their diffs in
   * either order and record either `after` as "the commit the map is level
   * with" — so the map's commit can move BACKWARDS, which hides the very gap
   * `before` exists to expose. `concurrencyKey` (passed at trigger time, per
   * classroom) gives each classroom its own copy of this queue, and the limit
   * of 1 on that copy is what serializes them. Classrooms still run in
   * parallel with each other.
   *
   * The queue is the fence, not the whole guarantee: a retry or a render-path
   * `ensureContentAssets` still runs outside it, which is why the incremental
   * commit write is also a compare-and-swap.
   */
  queue: { concurrencyLimit: 1 },
  run: async (payload: ContentAssetsSyncPayload) => {
    const { classroomId, reason, changes, forced, complete, before, after } = payload;

    // Three separate reasons the incremental path can't be used, all meaning
    // the same thing: we do not have a trustworthy list of what changed.
    const full = Boolean(forced) || complete === false || !changes;

    const result = await ClassmojiService.contentAssets.syncContentAssets(classroomId, {
      full,
      changes,
      before,
      after,
    });

    logger.info('Synced content assets', {
      classroomId,
      reason,
      mode: result.mode,
      upserted: result.upserted,
      deleted: result.deleted,
      truncated: result.truncated,
    });

    return result;
  },
});

/** How stale a map may get before the nightly sweep re-reads the whole tree. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How many classrooms sync concurrently. Each one is at least one GitHub tree
 * call plus a transaction, so this is the knob that keeps a sweep of a few
 * hundred classrooms from arriving at GitHub (and Postgres) all at once.
 */
const BATCH_SIZE = 20;

/**
 * Nightly backstop for a push webhook that never arrived.
 *
 * Delivery is not guaranteed — hook-station can be down, GitHub can drop a
 * delivery, a repo can be pushed to before its App install finishes. Without
 * this, a missed delivery means a permanently wrong map; with it, the cost is
 * staleness bounded by `MAX_AGE_MS`.
 *
 * Only classrooms that ALREADY have rows are swept. A classroom with no rows
 * has either never rendered a page or isn't served by the delivery layer at
 * all, and `ensureContentAssets` fixes it on its first render — sweeping every
 * classroom in the database would spend a GitHub tree call per night on
 * classrooms nobody is looking at.
 */
export const contentAssetsSweepTask = schedules.task({
  id: 'content-assets-sweep',
  // 05:25 UTC daily — off the hour, and clear of the other nightly jobs.
  cron: '25 5 * * *',
  run: async () => {
    const rows = await getPrisma().contentAsset.groupBy({
      by: ['classroom_id'],
    });
    const classroomIds = rows.map(row => row.classroom_id);

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < classroomIds.length; index += BATCH_SIZE) {
      const batch = classroomIds.slice(index, index + BATCH_SIZE);

      // allSettled, not all: one classroom whose repo was deleted, whose App
      // install was revoked, or which is simply rate-limited must not abandon
      // every classroom after it in the list.
      const results = await Promise.allSettled(
        batch.map(classroomId =>
          ClassmojiService.contentAssets.ensureContentAssets(classroomId, {
            maxAgeMs: MAX_AGE_MS,
          })
        )
      );

      results.forEach((result, offset) => {
        if (result.status === 'rejected') {
          failed += 1;
          logger.error('Could not sweep a classroom content-asset map', {
            classroomId: batch[offset],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
          return;
        }

        // ensureContentAssets returns null when the map was already fresh
        // enough, or when the classroom isn't one the delivery layer serves.
        if (result.value === null) {
          skipped += 1;
        } else {
          synced += 1;
        }
      });
    }

    logger.info('Swept content-asset maps', {
      classrooms: classroomIds.length,
      synced,
      skipped,
      failed,
    });

    return { classrooms: classroomIds.length, synced, skipped, failed };
  },
});
