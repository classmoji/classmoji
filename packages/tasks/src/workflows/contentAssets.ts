import { task, schedules, logger } from '@trigger.dev/sdk';
import { retryOnGitBlip } from '../helpers/gitRetry.ts';
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
 * A push webhook has to be answered fast, and a sync is a few GitHub calls
 * plus a transaction. hook-station decides the push is for a content repo and
 * hands the work here.
 *
 * ── What a run does ────────────────────────────────────────────────────────
 * Reads the branch head (never the push's `after`: a later push may already
 * have moved it, and the head is what the map should match), skips when the
 * map is already level with it, else reads the whole tree and applies the
 * diff. A redelivered push, a Trigger retry, or a push that a later run
 * already covered all land on the same rows.
 */

interface ContentAssetsSyncPayload {
  classroomId: string;
  reason: 'push' | 'ttl' | 'manual' | 'bootstrap';
  /** The commits the push spans; logged only — the run reads the branch head. */
  before?: string;
  after?: string;
}

export const contentAssetsSyncTask = task({
  id: 'content-assets-sync',
  // One blip left the asset map stale until the next push or the nightly
  // sweep. Safe to repeat: the run reads the head and diffs.
  ...retryOnGitBlip,
  /**
   * ONE sync per classroom at a time. `concurrencyKey` (passed at trigger
   * time, per classroom) gives each classroom its own copy of this queue, and
   * the limit of 1 on that copy serializes them, so a burst of pushes reads
   * the head one run at a time and the later runs skip as level. Classrooms
   * still run in parallel with each other. A render-path `ensureContentAssets`
   * runs outside the queue; the sync's stamp guards make that overlap safe.
   */
  queue: { concurrencyLimit: 1 },
  run: async (payload: ContentAssetsSyncPayload) => {
    const { classroomId, reason, before, after } = payload;

    // A push may skip when the map is already level with the head; a manual or
    // bootstrap run is asked for on purpose and always reads the tree.
    const result = await ClassmojiService.contentAssets.syncContentAssets(classroomId, {
      force: reason !== 'push',
    });

    logger.info('Synced content assets', {
      classroomId,
      reason,
      before,
      after,
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
  // Runs again on its schedule, and that next run is the retry.
  retry: { maxAttempts: 1 },
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
