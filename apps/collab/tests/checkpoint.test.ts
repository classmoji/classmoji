import { describe, expect, it, vi } from 'vitest';
import { CONTENT_CHECKPOINT_TASK } from '@classmoji/collab';

import { checkpointTriggerOptions, createTaskCheckpointTrigger } from '../src/checkpoint.ts';

const config = { checkpointDelay: '10s', checkpointMaxDelay: '30s' };
const payload = { classroomId: 'c1', reason: 'store' as const };

describe('createTaskCheckpointTrigger (tasks.trigger mocked)', () => {
  it('never calls tasks.trigger without TRIGGER_SECRET_KEY', async () => {
    const trigger = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = createTaskCheckpointTrigger(config, {}, async () => trigger);
    await t.trigger(payload, { now: false });
    await t.trigger(payload, { now: false });
    expect(trigger).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('triggers content-checkpoint by id with the debounce options', async () => {
    const trigger = vi.fn(async () => ({ id: 'run_1' }));
    const t = createTaskCheckpointTrigger(
      config,
      { TRIGGER_SECRET_KEY: 'tr_dev_x' },
      async () => trigger
    );
    await t.trigger(payload, { now: false });
    await t.trigger({ ...payload, reason: 'save-version' }, { now: true });
    expect(trigger).toHaveBeenNthCalledWith(
      1,
      CONTENT_CHECKPOINT_TASK,
      payload,
      checkpointTriggerOptions('c1', false, config)
    );
    expect(trigger).toHaveBeenNthCalledWith(
      2,
      CONTENT_CHECKPOINT_TASK,
      { ...payload, reason: 'save-version' },
      checkpointTriggerOptions('c1', true, config)
    );
  });

  it('swallows a failing trigger (the edits stay in collab_docs)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = createTaskCheckpointTrigger(
      config,
      { TRIGGER_SECRET_KEY: 'k' },
      async () => async () => {
        throw new Error('trigger.dev down');
      }
    );
    await expect(t.trigger(payload, { now: true })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('gives up on a trigger that hangs (bounded time under the save lock)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hang = () => new Promise<never>(() => {});
    const t = createTaskCheckpointTrigger(
      config,
      { TRIGGER_SECRET_KEY: 'k' },
      async () => hang,
      50
    );
    const started = Date.now();
    await t.trigger(payload, { now: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not cache a failed SDK load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trigger = vi.fn(async () => ({}));
    const load = vi
      .fn<() => Promise<typeof trigger>>()
      .mockRejectedValueOnce(new Error('import failed'))
      .mockResolvedValue(trigger);
    const t = createTaskCheckpointTrigger(config, { TRIGGER_SECRET_KEY: 'k' }, load);
    await t.trigger(payload, { now: false });
    await t.trigger(payload, { now: false });
    expect(load).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
