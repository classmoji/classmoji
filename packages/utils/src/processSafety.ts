/**
 * Process-level shutdown safety helpers.
 *
 * A naive crash handler such as
 *
 *   process.on('unhandledRejection', async () => {
 *     await disconnectPrisma();
 *     process.exit(1);
 *   });
 *
 * has two failure modes in a long-running server:
 *   1. If `disconnectPrisma()` rejects, the async handler itself produces a new
 *      unhandledRejection, which re-enters the same handler — a loop.
 *   2. If `disconnectPrisma()` hangs, `process.exit()` never runs and the
 *      supervisor cannot restart a clean process.
 *
 * createOneShotShutdown wraps cleanup so it runs at most once and the process
 * ALWAYS exits exactly once, even when cleanup rejects or hangs.
 */

export interface ShutdownOptions {
  /** Max time to wait for cleanup before forcing exit. Defaults to 5000ms. */
  timeoutMs?: number;
}

export function createOneShotShutdown(
  cleanup: () => Promise<void>,
  exit: (code: number) => void,
  options: ShutdownOptions = {}
): (code: number) => void {
  const { timeoutMs = 5000 } = options;
  let started = false;

  return (code: number) => {
    // Re-entrancy guard: a second trigger (e.g. cleanup itself causing another
    // unhandledRejection) must not run cleanup or exit again.
    if (started) return;
    started = true;

    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      exit(code);
    };

    // Force exit if cleanup hangs. unref() so the timer never keeps an
    // otherwise-idle process alive on its own.
    const timer: ReturnType<typeof setTimeout> = setTimeout(doExit, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    Promise.resolve()
      .then(cleanup)
      .catch(() => {
        // A cleanup failure must never prevent the process from exiting.
      })
      .finally(() => {
        clearTimeout(timer);
        doExit();
      });
  };
}
