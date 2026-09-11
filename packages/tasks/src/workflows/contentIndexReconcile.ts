import { task, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * Bring every classroom's `content_index` level with its content repo.
 *
 * ── Why this is the PRIMARY writer, not a backstop ──────────────────────────
 * The save hooks index a document the moment somebody edits it, and they are
 * the fast path — but they only ever see documents somebody edits. Everything
 * else arrives here: the push webhook (which records assets and warms nothing),
 * the slides.com importer, the two migration scripts, and — the largest
 * category by a wide margin — every document in the fleet that simply has not
 * been saved since the index shipped. Its first run IS the backfill.
 *
 * ── What it compares ───────────────────────────────────────────────────────
 * `planClassroomIndex` (in `contentIndex.service`) enumerates documents from
 * the `Page` and `Slide` ROWS rather than from the asset map, because a
 * classroom nobody has rendered has pages and an empty map — and starting from
 * the map would make "no map yet" and "nothing to index" the same answer, on
 * exactly the classrooms the index is missing entirely. The map is then asked
 * only which bytes each document is made of, and the reconcile refreshes it
 * itself (`ensureContentAssets`) rather than depending on the asset sweep's
 * timing.
 *
 * A document is work when its rows are missing, when its
 * `(source_sha, extract_version, embed_model)` stamp has moved, when a vector
 * is null, or when a multi-chunk document is only partly written.
 *
 * ── The report is the point ────────────────────────────────────────────────
 * Phase 3 turns Ask Moji into a client of these tools, and "is the index ready"
 * has to be answerable without reading a log for individual lines. So every
 * outcome is counted and bucketed by reason, and the whole thing is returned as
 * well as logged: `{ classrooms, eligible, indexed, skipped, failed,
 * orphansDeleted, byReason }`. `byReason.not_configured` equal to `eligible` is
 * the "no Workers AI token in this environment" shape; a rising
 * `byReason.sha_mismatch` is the delivery layer serving bytes the map does not
 * agree with.
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 * `reconcileContentIndex` counts a classroom's failure and moves to the next
 * one, for the same reason the asset sweep uses `allSettled`: one deleted repo,
 * one revoked App install or one rate limit must not abandon every classroom
 * after it in the list.
 */

/**
 * 05:45 UTC daily — twenty minutes after the content-asset sweep (`25 5`), so
 * it reads a map that has just been refreshed, and clear of the instructor
 * contacts job at `50 5`.
 */
const RECONCILE_CRON = '45 5 * * *';

export const contentIndexReconcileTask = schedules.task({
  id: 'content-index-reconcile',
  cron: RECONCILE_CRON,
  run: async () => {
    const report = await ClassmojiService.contentIndex.reconcileContentIndex();
    // ONE line, with the whole report on it. This is the readiness signal, and
    // a signal spread over N lines is one nobody can query.
    logger.info('Reconciled the content index', { ...report });
    return report;
  },
});

/**
 * The same run, aimed.
 *
 * The schedule above covers the fleet, but a backfill after a classroom import,
 * an `extract_version` bump, or a first switch-on wants one classroom now
 * rather than tomorrow morning — and a scheduled task takes no payload. Same
 * engine, same report, so there is no second implementation to drift.
 */
export const contentIndexBackfillTask = task({
  id: 'content-index-backfill',
  run: async (payload: { classroomIds?: string[]; concurrency?: number }) => {
    const report = await ClassmojiService.contentIndex.reconcileContentIndex({
      ...(payload?.classroomIds ? { classroomIds: payload.classroomIds } : {}),
      ...(payload?.concurrency ? { concurrency: payload.concurrency } : {}),
    });
    logger.info('Backfilled the content index', { ...report });
    return report;
  },
});
