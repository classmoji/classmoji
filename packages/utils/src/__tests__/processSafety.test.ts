import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOneShotShutdown } from '../processSafety.ts';

/**
 * The global uncaughtException/unhandledRejection handlers in
 * @classmoji/database previously ran `await disconnectPrisma(); process.exit()`
 * directly. Two failure modes crashed or hung the shutdown:
 *   1. If disconnect rejected, the async handler itself produced a NEW
 *      unhandledRejection that re-entered the same handler (loop).
 *   2. If disconnect hung, process.exit() never ran.
 *
 * createOneShotShutdown must run cleanup at most once and ALWAYS exit exactly
 * once, even if cleanup rejects or hangs.
 */
describe('createOneShotShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs cleanup then exits exactly once', async () => {
    const cleanup = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdown = createOneShotShutdown(cleanup, exit);
    shutdown(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still exits when cleanup rejects', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('disconnect failed');
    });
    const exit = vi.fn();

    const shutdown = createOneShotShutdown(cleanup, exit);
    shutdown(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit via timeout when cleanup hangs', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();

    const shutdown = createOneShotShutdown(cleanup, exit, { timeoutMs: 5000 });
    shutdown(1);

    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('is re-entrant safe: repeated calls run cleanup and exit only once', async () => {
    const cleanup = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdown = createOneShotShutdown(cleanup, exit);
    shutdown(1);
    shutdown(1);
    shutdown(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
