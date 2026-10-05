/**
 * collab-sweeper — every 30 minutes: re-trigger checkpoints nobody ran (and
 * refusals a retry now fixes), drop rows of deleted docs, turn week-idle
 * clean buffers into reseed markers so git is the only copy at rest, and
 * FAIL the run when live docs are stuck unsaved (so Trigger.dev's run-failure
 * alert fires). Policy in `helpers/collabSweeperCore.ts`, SQL in
 * `helpers/collabSweeperDb.ts`.
 *
 * Not in `src/index.ts`, like content-checkpoint: Trigger.dev finds it
 * through `dirs`, and nothing triggers it by hand.
 */

import { logger, schedules, tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { resolveCollabEnv } from '@classmoji/collab/env'; // eslint-disable-line import/no-unresolved

import {
  checkpointDelays,
  COLLAB_SWEEPER_CRON,
  runCollabSweep,
  type SweepDocRef,
} from '../helpers/collabSweeperCore.ts';
import { sqlSweeperDb } from '../helpers/collabSweeperDb.ts';
import { CHECKPOINT_TASK_ID } from './contentCheckpoint.ts';

/**
 * Whether collab has the doc open (its snapshot's `live`). Null — "leave it
 * alone" — when collab is not configured or does not answer.
 */
async function isLive(ref: SweepDocRef): Promise<boolean | null> {
  const env = resolveCollabEnv();
  if (!env) return null;
  try {
    const response = await fetch(
      `${env.httpUrl}/internal/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.doc_id)}/snapshot`,
      { headers: { 'x-collab-secret': env.secret }, signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { live?: unknown };
    return typeof body.live === 'boolean' ? body.live : null;
  } catch {
    return null;
  }
}

/** Collab `/close {reason: 'deleted'}`: closes the room and drops the row. */
async function closeDeleted(ref: SweepDocRef): Promise<boolean> {
  const env = resolveCollabEnv();
  if (!env) return false;
  try {
    const response = await fetch(
      `${env.httpUrl}/internal/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.doc_id)}/close`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-collab-secret': env.secret },
        body: JSON.stringify({ reason: 'deleted' }),
        signal: AbortSignal.timeout(5000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** The worker's schema versions, loaded inside the run (not at index time). */
async function schemaVersions(): Promise<{ page: number; deck: number } | undefined> {
  try {
    const [{ SCHEMA_VERSION }, collab] = await Promise.all([
      import('@classmoji/page-schema/constants'), // eslint-disable-line import/no-unresolved
      import('@classmoji/collab'), // eslint-disable-line import/no-unresolved
    ]);
    const deck = (collab as Record<string, unknown>).DECK_SCHEMA_VERSION;
    return typeof deck === 'number' ? { page: SCHEMA_VERSION, deck } : undefined;
  } catch (error) {
    logger.warn('collab-sweeper: schema versions unavailable; refusals not retried', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export const collabSweeper = schedules.task({
  id: 'collab-sweeper',
  // Every 30 minutes. The cadence only bounds how late each pass notices:
  // a lost trigger is re-run between 2 × COLLAB_CHECKPOINT_MAX_DELAY and that
  // plus 30 minutes after the doc went dirty, and the stuck-error alert fires
  // 1 to 1.5 hours in. None of the thresholds needs to change with it.
  cron: COLLAB_SWEEPER_CRON,
  maxDuration: 240,
  run: async () => {
    const delays = checkpointDelays();
    return runCollabSweep({
      db: sqlSweeperDb(getPrisma()),
      delays,
      // A PLAIN run, no debounce key: the trigger this replaces may be a
      // debounced run Trigger.dev left DELAYED, which would absorb another
      // trigger on its key. Runs are idempotent; an extra one finds nothing.
      triggerCheckpoint: async classroomId => {
        await tasks.trigger(
          CHECKPOINT_TASK_ID,
          { classroomId, reason: 'store' },
          { concurrencyKey: classroomId }
        );
      },
      isLive,
      closeDeleted,
      schemaVersions: await schemaVersions(),
      log: {
        info: (m, d) => logger.info(m, d),
        warn: (m, d) => logger.warn(m, d),
        error: (m, d) => logger.error(m, d),
      },
    });
  },
});
