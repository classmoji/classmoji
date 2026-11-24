/**
 * Bounded wait for a Trigger.dev run — for callers that must not hang on a
 * stalled run (an MCP request). The web routes subscribe with their own
 * waitForRunCompletion; this polls runs.retrieve with a deadline and reports
 * the outcome instead of throwing, so the caller decides what "not yet" means.
 *
 * Never throws and never outlives its deadline: each retrieve is capped
 * (Promise.race — the SDK's request options have no timeout, only a retry
 * policy, which is set to a single attempt here), and a retrieve that throws or
 * times out is treated as "not known yet" and polled again until the deadline.
 * A wait that never learned the status reports `{ outcome: 'timeout', status: null }`.
 *
 * A completed run reports its `output` (the task's return value, as
 * `runs.retrieve` resolves it, offloaded outputs included); a caller that
 * needs it treats a missing output as a failure.
 *
 * `maxPollMs` above `pollMs` backs the polling off (each wait 1.5x the last,
 * up to `maxPollMs`): every retrieve of a run with a large payload downloads
 * that payload again.
 *
 * `failFastStatuses` (opt-in; no other caller passes it) ends the wait the
 * first time the run is seen in one of them, reported as `failed` with that
 * status: e.g. `PENDING_VERSION`, a run for a task the deployed worker does
 * not have yet, which would otherwise sit until the deadline.
 */
import { runs } from '@trigger.dev/sdk';

/** Terminal statuses that are not success (the SDK's RunStatus). */
const FAILED_RUN_STATUSES = new Set([
  'CANCELED',
  'FAILED',
  'CRASHED',
  'SYSTEM_FAILURE',
  'EXPIRED',
  'TIMED_OUT',
]);

export type RunOutcome =
  | { outcome: 'completed'; output: unknown }
  | { outcome: 'failed'; status: string }
  | { outcome: 'timeout'; status: string | null };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Reject if `promise` has not settled within `ms`. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export const waitForRunOutcome = async (
  runId: string,
  {
    timeoutMs = 45_000,
    pollMs = 1_000,
    callTimeoutMs = 5_000,
    maxPollMs = pollMs,
    failFastStatuses = [],
  }: {
    timeoutMs?: number;
    pollMs?: number;
    callTimeoutMs?: number;
    maxPollMs?: number;
    failFastStatuses?: readonly string[];
  } = {}
): Promise<RunOutcome> => {
  const deadline = Date.now() + timeoutMs;
  let status: string | null = null;
  let interval = pollMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: 'timeout', status };

    try {
      const run = await withTimeout(
        Promise.resolve(runs.retrieve(runId, { retry: { maxAttempts: 1 } })),
        Math.min(callTimeoutMs, remaining)
      );
      status = String(run.status);
      if (status === 'COMPLETED' || status === 'COMPLETED_SUCCESSFULLY') {
        return { outcome: 'completed', output: run.output };
      }
      if (FAILED_RUN_STATUSES.has(status) || failFastStatuses.includes(status)) {
        return { outcome: 'failed', status };
      }
    } catch (error) {
      // A network blip or a slow API is not an answer: keep polling.
      console.warn(`[runWait] could not read run ${runId}:`, error);
    }

    if (Date.now() + interval >= deadline) return { outcome: 'timeout', status };
    await sleep(interval);
    interval = Math.min(maxPollMs, Math.round(interval * 1.5));
  }
};
