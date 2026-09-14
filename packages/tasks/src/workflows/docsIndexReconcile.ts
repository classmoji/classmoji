import { schemaTask, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * Bring `docs_index` level with the documentation on `main`.
 *
 * ── What it does, and why the FIRST run is the whole feature ───────────────
 * Unlike the course index, there is no save-time hook here and there never
 * will be: the documentation lives in a git repo that this platform does not
 * host, and nothing in the webapp knows when somebody merges a docs PR. This
 * task is therefore the ONLY writer's only caller, and until it has run once on
 * a deployment, `content_search` with `scope: 'docs'` answers with the
 * `docs_index_empty` marker rather than with content.
 *
 * ── BOTH TASKS SHARE ONE QUEUE, AND THAT IS LOAD-BEARING ───────────────────
 * The reconcile ends with a sweep — every slug not in that run's tree is
 * deleted — so two overlapping runs are not merely wasteful, they are
 * destructive: a slow run pinned to commit A finishing after a run pinned to
 * commit B deletes the pages B introduced. The damage then heals itself at the
 * next nightly, which is exactly why nobody would notice a day of wrong
 * answers.
 *
 * Trigger.dev gives each task id its OWN queue unless they are told to share
 * one, so `concurrencyLimit: 1` on two separate task definitions would serialize
 * each task against itself and do nothing at all about the scheduled run and a
 * manual backfill overlapping — which is the realistic case, because a backfill
 * is triggered by hand precisely when somebody is impatient. Hence the explicit
 * shared `name: 'docs-index'`.
 *
 * The advisory lock inside `reconcileDocsIndex` is the second belt, for callers
 * that are not Trigger at all.
 *
 * ── The report is the readiness signal ─────────────────────────────────────
 * Returned as well as logged, on ONE line, whole. "Is the docs index ready" has
 * to be answerable without reading a log for individual lines. Readiness is
 * `!halted && !error && failed === 0` — NOT `!error` alone: `lock_held` is the
 * serialization working and `not_configured` is a deployment with no Workers AI
 * credentials, and neither is an error, but neither indexed anything either.
 */

/**
 * 06:10 UTC daily.
 *
 * Clear of all six existing crons (`15 3`, `1 4`, `40 4`, `25 5`, `45 5`,
 * `50 5`) and twenty-five minutes after `content-index-reconcile`. With
 * `maxDuration: 900` an ordinary on-time overlap is unlikely — but a delayed
 * run and a manual backfill both remain possible, which is what the shared
 * queue and the advisory lock are actually for. The gap is hygiene, not a
 * guarantee.
 */
const RECONCILE_CRON = '10 6 * * *';

/**
 * The ONE queue both task ids sit on.
 *
 * Declared here rather than written out twice, so a future edit cannot move one
 * task off it and leave the other looking fine.
 */
export const DOCS_INDEX_QUEUE = { name: 'docs-index', concurrencyLimit: 1 } as const;

export const docsIndexReconcileTask = schedules.task({
  id: 'docs-index-reconcile',
  cron: RECONCILE_CRON,
  queue: DOCS_INDEX_QUEUE,
  run: async () => {
    const report = await ClassmojiService.docsIndex.reconcileDocsIndex();
    // ONE line, with the whole report on it — the commit sha included, because
    // this indexes the latest `main`, which may be ahead of the deployed site.
    logger.info('Reconciled the docs index', { ...report });
    return report;
  },
});

export interface DocsIndexBackfillPayload {
  concurrency?: number;
}

/**
 * Everything the payload may contain.
 *
 * Just the one. There is no `classroomIds` here and there cannot be: the docs
 * corpus is fleet-wide and classroom-independent, which is the entire reason it
 * is a separate table.
 */
const PAYLOAD_KEYS = ['concurrency'] as const;

/**
 * How many pages may be in flight at once.
 *
 * Each is a raw fetch plus a Workers AI embed call, so concurrency here is
 * concurrency against github.com and Cloudflare. Eight is already past the
 * point where a backfill starts competing with live traffic for the same rate
 * limits.
 */
const MAX_CONCURRENCY = 8;

const reject = (message: string): never => {
  throw new Error(`[docs-index-backfill] ${message}`);
};

/**
 * Strict payload validation, run by `schemaTask` BEFORE `run`.
 *
 * Hand-written rather than a Zod schema for the same reason as its siblings:
 * `@classmoji/tasks` does not depend on Zod, and `schemaTask` accepts a plain
 * validator.
 *
 * UNKNOWN KEYS ARE A HARD FAILURE. A payload the operator believed narrowed or
 * shaped the run — `{ "classroomIds": [...] }` copied from the content
 * backfill, `{ "Concurrency": 2 }` with a capital C — must fail loudly rather
 * than quietly mean "the defaults" at whatever hour it was triggered.
 */
export const parseDocsBackfillPayload = (input: unknown): DocsIndexBackfillPayload => {
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

  const payload: DocsIndexBackfillPayload = {};

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
 * The same run, on demand.
 *
 * This is the one that matters on a fresh deployment: the schedule covers
 * tomorrow, and "the docs index has not been built here yet" is a state that
 * wants fixing now. Same engine, same report, so there is no second
 * implementation to drift — and the same queue, so it cannot race the schedule.
 */
export const docsIndexBackfillTask = schemaTask({
  id: 'docs-index-backfill',
  schema: parseDocsBackfillPayload,
  queue: DOCS_INDEX_QUEUE,
  run: async (payload: DocsIndexBackfillPayload) => {
    const report = await ClassmojiService.docsIndex.reconcileDocsIndex({
      ...(payload?.concurrency ? { concurrency: payload.concurrency } : {}),
    });
    logger.info('Backfilled the docs index', { ...report });
    return report;
  },
});
