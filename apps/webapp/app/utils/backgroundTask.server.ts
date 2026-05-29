/**
 * Run a fire-and-forget async task without risking an unhandled promise
 * rejection.
 *
 * A bare `setTimeout(async () => { ... })` — or any un-awaited async call —
 * runs on a fresh stack outside the request handler's try/catch. If its body
 * rejects (including from inside its own catch block, e.g. a fallback DB write
 * that fails), the rejection has no handler and surfaces as an
 * `unhandledRejection`. The global handler registered in @classmoji/database
 * turns every unhandledRejection into `process.exit(1)`, so a single failed
 * background write crashes the entire SSR process for all users.
 *
 * This wrapper guarantees any rejection is caught and logged instead of
 * escaping. Use it for genuinely fire-and-forget work whose result the caller
 * does not await.
 */
export function runBackgroundTask(label: string, task: () => unknown | Promise<unknown>): void {
  // Promise.resolve().then(task) funnels BOTH synchronous throws and async
  // rejections from `task` into the single .catch below.
  Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      console.error(
        `[backgroundTask:${label}] background work failed (suppressed to protect process):`,
        error
      );
    });
}
