/**
 * collab-sweeper — every 30 minutes: re-trigger checkpoints nobody ran, alert
 * on live docs stuck unsaved for over an hour, and turn week-idle clean
 * buffers into reseed markers so git is the only copy at rest. Policy in
 * `helpers/collabSweeperCore.ts`, SQL in `helpers/collabSweeperDb.ts`.
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
      // The collab server's own debounce key and options, so a re-trigger
      // folds into any checkpoint already waiting for this classroom.
      triggerCheckpoint: async classroomId => {
        await tasks.trigger(
          CHECKPOINT_TASK_ID,
          { classroomId, reason: 'store' },
          {
            concurrencyKey: classroomId,
            debounce: {
              key: `checkpoint:${classroomId}`,
              delay: delays.delay,
              maxDelay: delays.maxDelay,
              mode: 'trailing',
            },
          }
        );
      },
      isLive,
      log: {
        info: (m, d) => logger.info(m, d),
        warn: (m, d) => logger.warn(m, d),
        error: (m, d) => logger.error(m, d),
      },
    });
  },
});
