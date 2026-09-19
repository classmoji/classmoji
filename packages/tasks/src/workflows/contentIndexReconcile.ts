import { schemaTask, schedules, logger } from '@trigger.dev/sdk';
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
 * classroomErrors, orphansDeleted, byReason, byClassroom }`.
 * `byReason.not_configured` equal to `eligible` is the "no Workers AI token in
 * this environment" shape; a rising `byReason.sha_mismatch` is the delivery
 * layer serving bytes the map does not agree with; a non-zero
 * `byReason.assets_unavailable` is a classroom whose asset map never came back,
 * whose `bot-context/` rows the sweep therefore declined to delete.
 *
 * `failed` counts DOCUMENTS and `classroomErrors` counts CLASSROOMS, separately
 * — a fleet-wide `failed: 40` reads identically whether it is one dead repo or
 * forty unlucky documents, and the gate has to tell those apart. `byClassroom`
 * carries the same counters per classroom, each row with an `error` when that
 * classroom was abandoned whole, so the culprit is named rather than inferred.
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

export interface ContentIndexBackfillPayload {
  classroomIds?: string[];
  concurrency?: number;
}

/** Everything the payload may contain. Anything else is a typo, not an option. */
const PAYLOAD_KEYS = ['classroomIds', 'concurrency'] as const;

/** Canonical 8-4-4-4-12, any case. `Classroom.id` is a uuid in every row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many documents may be in flight at once, ceiling included.
 *
 * Each one is a content fetch plus a Workers AI embed call, so concurrency here
 * is concurrency against GitHub and Cloudflare. Eight is already past the point
 * where a backfill starts competing with live traffic for the same rate limits;
 * a typo'd `concurrency: 800` would take the fleet's content reads down with it.
 */
const MAX_CONCURRENCY = 8;

const reject = (message: string): never => {
  throw new Error(`[content-index-backfill] ${message}`);
};

/**
 * Strict payload validation, run by `schemaTask` BEFORE `run`.
 *
 * Hand-written rather than a Zod schema for the same reason as
 * `gitOrgInstallationRepair`: `@classmoji/tasks` does not depend on Zod and no
 * sibling task pulls one in, and `schemaTask` accepts a plain validator.
 *
 * Unknown keys are a hard failure. This task's default is the WHOLE FLEET, so a
 * payload the operator believed narrowed the run — `{ "classroomId": "…" }`,
 * `{ "classroom_ids": [...] }` — must fail loudly rather than quietly mean
 * "re-index everything" at whatever hour it was triggered.
 */
export const parseBackfillPayload = (input: unknown): ContentIndexBackfillPayload => {
  if (input === undefined || input === null) return {};

  if (typeof input !== 'object' || Array.isArray(input)) {
    reject('payload must be an object');
  }

  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    key => !(PAYLOAD_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    reject(
      `unknown payload key(s): ${unknown.join(', ')} — expected only ${PAYLOAD_KEYS.join(', ')}`
    );
  }

  const payload: ContentIndexBackfillPayload = {};

  if (raw.classroomIds !== undefined) {
    if (!Array.isArray(raw.classroomIds) || raw.classroomIds.length === 0) {
      reject('classroomIds must be a non-empty array of classroom uuids');
    }
    const ids = raw.classroomIds as unknown[];
    if (ids.some(id => typeof id !== 'string' || !UUID.test(id))) {
      reject('classroomIds must all be classroom uuids');
    }
    payload.classroomIds = ids as string[];
  }

  if (raw.concurrency !== undefined) {
    const value = raw.concurrency;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_CONCURRENCY
    ) {
      reject(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
    }
    payload.concurrency = value as number;
  }

  return payload;
};

/**
 * The same run, aimed.
 *
 * The schedule above covers the fleet, but a backfill after a classroom import,
 * an `extract_version` bump, or a first switch-on wants one classroom now
 * rather than tomorrow morning — and a scheduled task takes no payload. Same
 * engine, same report, so there is no second implementation to drift.
 */
export const contentIndexBackfillTask = schemaTask({
  id: 'content-index-backfill',
  schema: parseBackfillPayload,
  run: async (payload: ContentIndexBackfillPayload) => {
    const report = await ClassmojiService.contentIndex.reconcileContentIndex({
      ...(payload?.classroomIds ? { classroomIds: payload.classroomIds } : {}),
      ...(payload?.concurrency ? { concurrency: payload.concurrency } : {}),
    });
    logger.info('Backfilled the content index', { ...report });
    return report;
  },
});
