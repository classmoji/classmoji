/**
 * Unit tests for the team-set apply task's failure and cancel paths.
 *
 * `applyCreate` records its own progress and final state; the task only has to
 * make sure a create that stops without finishing is not left RUNNING, and it
 * does that through `teamSet.stopCreate` (never a direct create_state write):
 *  - a throw that escapes applyCreate calls stopCreate with `internal_error`,
 *    then rethrows a sanitized error;
 *  - onCancel leaves a run function that settles alone, and calls stopCreate
 *    with `canceled` when it is still going after the grace.
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applyCreate = vi.fn();
const stopCreate = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@trigger.dev/sdk', () => ({ task: (config: unknown) => config, logger }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { teamSet: { applyCreate, stopCreate } },
}));

const { teamSetApplyTask, CANCEL_GRACE_MS } = await import('../teamSetApply.ts');
const applyTask = teamSetApplyTask as unknown as {
  run: (payload: { teamSetId: string }) => Promise<unknown>;
  onCancel: (params: {
    payload: { teamSetId: string };
    runPromise: Promise<unknown>;
  }) => Promise<void>;
};

describe('team-set-apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopCreate.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('stops the create as internal_error when applyCreate throws, and rethrows sanitized', async () => {
    applyCreate.mockRejectedValue(
      Object.assign(new Error('db gone at login octocat'), { code: 'P1001' })
    );

    const error = await applyTask.run({ teamSetId: 's1' }).catch((e: Error) => e);
    expect((error as Error).message).toBe('team-set-apply failed: P1001');
    expect(stopCreate).toHaveBeenCalledWith({ teamSetId: 's1', reason: 'internal_error' });
  });

  it('still rethrows when stopCreate itself fails', async () => {
    applyCreate.mockRejectedValue(new Error('late failure'));
    stopCreate.mockRejectedValue(new Error('db still gone'));

    await expect(applyTask.run({ teamSetId: 's2' })).rejects.toThrow(
      'team-set-apply failed: unexpected'
    );
  });

  it('does not stop a create that applyCreate finished', async () => {
    applyCreate.mockResolvedValue({ status: 'DONE', total: 1, done: 1, teams: [], failed: [] });

    await applyTask.run({ teamSetId: 's3' });
    expect(stopCreate).not.toHaveBeenCalled();
  });

  it('onCancel leaves the outcome to a run function that settles', async () => {
    await applyTask.onCancel({ payload: { teamSetId: 's4' }, runPromise: Promise.resolve() });
    await applyTask.onCancel({
      payload: { teamSetId: 's4' },
      runPromise: Promise.reject(new Error('team-set-apply failed: unexpected')),
    });
    expect(stopCreate).not.toHaveBeenCalled();
  });

  it('onCancel stops a create still going after the grace as canceled', async () => {
    vi.useFakeTimers();
    const pending = applyTask.onCancel({
      payload: { teamSetId: 's5' },
      runPromise: new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
    await pending;
    expect(stopCreate).toHaveBeenCalledTimes(1);
    expect(stopCreate).toHaveBeenCalledWith({ teamSetId: 's5', reason: 'canceled' });
  });
});
