/**
 * waitForRunOutcome — the bounded run wait staff_remove uses.
 *
 * Pinned: each terminal status maps to its outcome; a run still going at the
 * deadline is a timeout; a retrieve that throws (or hangs) is retried and never
 * escapes, and a wait that never learned the status reports status: null.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieve = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({
  runs: { retrieve: (...a: unknown[]) => retrieve(...a) },
}));

const { waitForRunOutcome } = await import('../runWait.ts');

const fast = { pollMs: 5, callTimeoutMs: 20 };

beforeEach(() => {
  retrieve.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('waitForRunOutcome', () => {
  it.each(['COMPLETED', 'COMPLETED_SUCCESSFULLY'])('%s is completed', async status => {
    retrieve.mockResolvedValue({ status });
    await expect(waitForRunOutcome('run-1', { timeoutMs: 200, ...fast })).resolves.toEqual({
      outcome: 'completed',
    });
    // One attempt per call: the SDK's own retries would outlast the deadline.
    expect(retrieve).toHaveBeenCalledWith('run-1', { retry: { maxAttempts: 1 } });
  });

  it.each(['CANCELED', 'FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT'])(
    '%s is failed',
    async status => {
      retrieve.mockResolvedValue({ status });
      await expect(waitForRunOutcome('run-1', { timeoutMs: 200, ...fast })).resolves.toEqual({
        outcome: 'failed',
        status,
      });
    }
  );

  it('polls until the run finishes', async () => {
    retrieve
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'EXECUTING' })
      .mockResolvedValue({ status: 'COMPLETED' });
    await expect(waitForRunOutcome('run-1', { timeoutMs: 500, ...fast })).resolves.toEqual({
      outcome: 'completed',
    });
    expect(retrieve).toHaveBeenCalledTimes(3);
  });

  it('a run still going at the deadline is a timeout with its last status', async () => {
    retrieve.mockResolvedValue({ status: 'EXECUTING' });
    const started = Date.now();
    await expect(waitForRunOutcome('run-1', { timeoutMs: 60, ...fast })).resolves.toEqual({
      outcome: 'timeout',
      status: 'EXECUTING',
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a retrieve that throws is retried, and never escapes', async () => {
    retrieve.mockRejectedValue(new Error('ECONNRESET'));
    await expect(waitForRunOutcome('run-1', { timeoutMs: 60, ...fast })).resolves.toEqual({
      outcome: 'timeout',
      status: null,
    });
    expect(retrieve.mock.calls.length).toBeGreaterThan(1);
  });

  it('recovers when a throwing retrieve starts answering', async () => {
    retrieve.mockRejectedValueOnce(new Error('503')).mockResolvedValue({ status: 'COMPLETED' });
    await expect(waitForRunOutcome('run-1', { timeoutMs: 500, ...fast })).resolves.toEqual({
      outcome: 'completed',
    });
  });

  it('a retrieve that hangs is cut off and the wait still ends by the deadline', async () => {
    retrieve.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(waitForRunOutcome('run-1', { timeoutMs: 80, ...fast })).resolves.toEqual({
      outcome: 'timeout',
      status: null,
    });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
