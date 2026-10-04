/**
 * Triggering the git worker (`content-checkpoint`, packages/tasks — imported
 * by id, never by importing the task's code).
 *
 * - after a store: trailing debounce per classroom (`checkpoint:<id>`,
 *   COLLAB_CHECKPOINT_DELAY / _MAX_DELAY), so a burst of typing makes one
 *   commit per window;
 * - "Save version", last leave, close / flag off: a separate 1-s debounce key
 *   (`checkpoint-now:<id>`), so a long editing window can't hold them back.
 *
 * `concurrencyKey: classroomId` with the task's queue (concurrency 1) keeps
 * one push per content repo at a time. A trigger that fails is logged and
 * dropped: the edits are safe in collab_docs and the next store re-triggers.
 */
import { CONTENT_CHECKPOINT_TASK, type ContentCheckpointPayload } from '@classmoji/collab';

import type { CollabConfig } from './config.ts';

export interface CheckpointTrigger {
  trigger(payload: ContentCheckpointPayload, options: { now: boolean }): Promise<void>;
}

export interface TriggerOptions {
  concurrencyKey: string;
  debounce: { key: string; delay: string; maxDelay?: string; mode: 'trailing' };
}

/** The options `tasks.trigger` gets, exported for tests. */
export function checkpointTriggerOptions(
  classroomId: string,
  now: boolean,
  config: Pick<CollabConfig, 'checkpointDelay' | 'checkpointMaxDelay'>
): TriggerOptions {
  return now
    ? {
        concurrencyKey: classroomId,
        debounce: { key: `checkpoint-now:${classroomId}`, delay: '1s', mode: 'trailing' },
      }
    : {
        concurrencyKey: classroomId,
        debounce: {
          key: `checkpoint:${classroomId}`,
          delay: config.checkpointDelay,
          maxDelay: config.checkpointMaxDelay,
          mode: 'trailing',
        },
      };
}

type TasksTrigger = (
  id: string,
  payload: ContentCheckpointPayload,
  options: TriggerOptions
) => Promise<unknown>;

/** The real trigger via `@trigger.dev/sdk` (TRIGGER_SECRET_KEY from env). */
export function createTaskCheckpointTrigger(
  config: Pick<CollabConfig, 'checkpointDelay' | 'checkpointMaxDelay'>,
  env: NodeJS.ProcessEnv = process.env,
  loadTrigger: () => Promise<TasksTrigger> = async () => {
    const { tasks } = await import('@trigger.dev/sdk');
    return (id, payload, options) => tasks.trigger(id, payload, options);
  }
): CheckpointTrigger {
  let warned = false;
  let trigger: Promise<TasksTrigger> | null = null;

  return {
    async trigger(payload, { now }) {
      if (!env.TRIGGER_SECRET_KEY) {
        if (!warned) {
          console.warn('[collab] TRIGGER_SECRET_KEY is not set; checkpoints are not triggered');
          warned = true;
        }
        return;
      }
      try {
        trigger ??= loadTrigger();
        await (
          await trigger
        )(
          CONTENT_CHECKPOINT_TASK,
          payload,
          checkpointTriggerOptions(payload.classroomId, now, config)
        );
      } catch (err) {
        console.error(
          `[collab] could not trigger ${CONTENT_CHECKPOINT_TASK} for classroom ${payload.classroomId}:`,
          err
        );
      }
    },
  };
}
