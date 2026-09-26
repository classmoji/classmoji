/**
 * Bounded wait for a Trigger.dev run — for callers that must not hang on a
 * stalled run (an MCP request). The web routes subscribe with their own
 * waitForRunCompletion; this polls runs.retrieve with a deadline and reports
 * the outcome instead of throwing, so the caller decides what "not yet" means.
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
  | { outcome: 'completed' }
  | { outcome: 'failed'; status: string }
  | { outcome: 'timeout'; status: string | null };

export const waitForRunOutcome = async (
  runId: string,
  { timeoutMs = 45_000, pollMs = 1_000 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<RunOutcome> => {
  const deadline = Date.now() + timeoutMs;
  let status: string | null = null;
  for (;;) {
    status = String((await runs.retrieve(runId)).status);
    if (status === 'COMPLETED' || status === 'COMPLETED_SUCCESSFULLY') {
      return { outcome: 'completed' };
    }
    if (FAILED_RUN_STATUSES.has(status)) return { outcome: 'failed', status };
    if (Date.now() + pollMs > deadline) return { outcome: 'timeout', status };
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};
