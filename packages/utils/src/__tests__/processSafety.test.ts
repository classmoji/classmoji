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

  it('unref()s the force-exit timer so it never keeps an idle process alive', () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    // Capture the timer object returned by setTimeout and attach a spy on unref.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    });

    const cleanup = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();

    const shutdown = createOneShotShutdown(cleanup, exit);
    shutdown(1);

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    // Removing the unref() guard (re-introducing the process-hang bug) fails this.
    expect(unref).toHaveBeenCalledOnce();
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

  // Mirrors @classmoji/database/index.ts wiring: ONE shutdown instance is shared
  // between the uncaughtException and unhandledRejection handlers. If both fire
  // (e.g. an uncaught error followed by a rejection during teardown), cleanup
  // and exit must still each run exactly once.
  it('shares one instance across two trigger paths and runs cleanup/exit once', async () => {
    const cleanup = vi.fn(async () => {});
    const exit = vi.fn();

    const shutdownWithFailure = createOneShotShutdown(cleanup, exit, { timeoutMs: 5000 });

    const onUncaughtException = () => shutdownWithFailure(1);
    const onUnhandledRejection = () => shutdownWithFailure(1);

    // Two distinct trigger paths invoke the shared instance.
    onUncaughtException();
    onUnhandledRejection();

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
