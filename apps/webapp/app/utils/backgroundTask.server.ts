/**
 * Runs fire-and-forget work, catching any failure so it cannot escape as an
 * unhandled rejection (which the global handler turns into a process exit).
 */
export function runBackgroundTask(label: string, task: () => unknown | Promise<unknown>): void {
  Promise.resolve()
    .then(task)
    .catch((error: unknown) => {
      console.error(
        `[backgroundTask:${label}] background work failed (suppressed to protect process):`,
        error
      );
    });
}
