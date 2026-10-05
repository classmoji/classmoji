/**
 * Triggering the git worker (`content-checkpoint`, packages/tasks — imported
 * by id, never by importing the task's code).
 *
 * - after a store: trailing debounce per classroom (`checkpoint:<id>`,
 *   COLLAB_CHECKPOINT_DELAY / _MAX_DELAY), so a burst of typing makes one
 *   commit per window;
 * - "Save version", last leave, close / flag off: a separate 1-s debounce key
 *   (`checkpoint-now:<id>`, at most CHECKPOINT_NOW_MAX_DELAY late), so a long
 *   editing window can't hold them back;
 * - collab's watchdog (server.ts), when a trigger went missing: a plain run
 *   with NO debounce key. A debounced run that Trigger.dev leaves DELAYED
 *   past its time keeps absorbing every later trigger on its key, so a
 *   re-trigger on the same key would vanish into it too. After a loss the
 *   keys also move to a new `generation` (`checkpoint:<id>:<n>`).
 *
 * `concurrencyKey: classroomId` with the task's queue (concurrency 1) keeps
 * one push per content repo at a time. A trigger that fails is logged and
 * dropped: the edits are safe in collab_docs and the next store re-triggers.
 */
import { CONTENT_CHECKPOINT_TASK, type ContentCheckpointPayload } from '@classmoji/collab';

import type { CollabConfig } from './config.ts';

export interface CheckpointTriggerOptions {
  now: boolean;
  /** No debounce key at all (the watchdog's re-trigger). */
  plain?: boolean;
  /** Debounce key generation (0 = the plain `checkpoint:<id>` keys). */
  generation?: number;
}

export interface CheckpointTrigger {
  /** `false`: not sent because triggering is not configured (dev without a key). */
  trigger(
    payload: ContentCheckpointPayload,
    options: CheckpointTriggerOptions
  ): Promise<void | boolean>;
}

export interface TriggerOptions {
  concurrencyKey: string;
  debounce?: { key: string; delay: string; maxDelay?: string; mode: 'trailing' };
}

/**
 * The longest a "now" checkpoint waits. Trigger.dev pushes a debounced run
 * back on every trigger of its key, without limit unless `maxDelay` is set.
 */
export const CHECKPOINT_NOW_DELAY = '1s';
export const CHECKPOINT_NOW_MAX_DELAY = '10s'; // = config.ts default for checkpointNowMaxDelay

/** The options `tasks.trigger` gets, exported for tests. */
export function checkpointTriggerOptions(
  classroomId: string,
  now: boolean,
  config: Pick<CollabConfig, 'checkpointDelay' | 'checkpointMaxDelay'> &
    Partial<Pick<CollabConfig, 'checkpointNowMaxDelay'>>,
  { plain = false, generation = 0 }: { plain?: boolean; generation?: number } = {}
): TriggerOptions {
  if (plain) return { concurrencyKey: classroomId };
  const suffix = generation > 0 ? `:${generation}` : '';
  return now
    ? {
        concurrencyKey: classroomId,
        debounce: {
          key: `checkpoint-now:${classroomId}${suffix}`,
          delay: CHECKPOINT_NOW_DELAY,
          maxDelay: config.checkpointNowMaxDelay ?? CHECKPOINT_NOW_MAX_DELAY,
          mode: 'trailing',
        },
      }
    : {
        concurrencyKey: classroomId,
        debounce: {
          key: `checkpoint:${classroomId}${suffix}`,
          delay: config.checkpointDelay,
          maxDelay: config.checkpointMaxDelay,
          mode: 'trailing',
        },
      };
}

/** `10s` / `4m` / `1h` / `2d` / `1w` → ms (the config's duration format). */
export function durationMs(value: string): number {
  const m = /^(\d+)([smhdw])$/.exec(value.trim());
  if (!m) throw new Error(`not a duration: ${value}`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[
    m[2] as 's' | 'm' | 'h' | 'd' | 'w'
  ];
  return Number(m[1]) * unit;
}

type TasksTrigger = (
  id: string,
  payload: ContentCheckpointPayload,
  options: TriggerOptions
) => Promise<unknown>;

/** How long a trigger may take before the store moves on (it runs under the doc's save lock). */
export const TRIGGER_TIMEOUT_MS = 5_000;

/** The real trigger via `@trigger.dev/sdk` (TRIGGER_SECRET_KEY from env). */
export function createTaskCheckpointTrigger(
  config: Pick<CollabConfig, 'checkpointDelay' | 'checkpointMaxDelay'> &
    Partial<Pick<CollabConfig, 'checkpointNowMaxDelay'>>,
  env: NodeJS.ProcessEnv = process.env,
  loadTrigger: () => Promise<TasksTrigger> = async () => {
    const { tasks } = await import('@trigger.dev/sdk');
    return (id, payload, options) => tasks.trigger(id, payload, options);
  },
  timeoutMs: number = TRIGGER_TIMEOUT_MS
): CheckpointTrigger {
  let warned = false;
  let loading: Promise<TasksTrigger> | null = null;

  return {
    async trigger(payload, { now, plain, generation }) {
      if (!env.TRIGGER_SECRET_KEY) {
        if (!warned) {
          console.warn('[collab] TRIGGER_SECRET_KEY is not set; checkpoints are not triggered');
          warned = true;
        }
        return false;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        // A rejected load is not cached: the next trigger tries again.
        loading ??= loadTrigger().catch(err => {
          loading = null;
          throw err;
        });
        const call = (async () =>
          (await loading!)(
            CONTENT_CHECKPOINT_TASK,
            payload,
            checkpointTriggerOptions(payload.classroomId, now, config, { plain, generation })
          ))();
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
          timer.unref();
        });
        await Promise.race([call, timeout]);
      } catch (err) {
        console.error(
          `[collab] could not trigger ${CONTENT_CHECKPOINT_TASK} for classroom ${payload.classroomId}:`,
          err
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
