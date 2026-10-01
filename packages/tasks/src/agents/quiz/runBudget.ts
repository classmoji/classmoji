/**
 * When a quiz run ends between turns instead of waiting for the next message:
 * once the compute it has used reaches `QUIZ_RUN_COMPUTE_BUDGET_MS`, so the
 * next turn can never run into the run's `maxDuration`. The agent asks after
 * every turn (`onTurnComplete`) and calls `chat.endRun()`; the next message
 * starts a new run on the same conversation.
 */
import { QUIZ_RUN_COMPUTE_BUDGET_MS } from '@classmoji/utils/quiz-agent';

/** Whether a run that has used `usedMs` of compute ends after this turn. */
export function shouldEndRun(usedMs: number): boolean {
  return usedMs >= QUIZ_RUN_COMPUTE_BUDGET_MS;
}
