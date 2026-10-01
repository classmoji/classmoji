/**
 * How long one run of the quiz agent goes on: its turn limit, its compute
 * limit, and when it ends between turns so it never meets either mid-turn.
 * The next message after a run ends starts a new run on the same
 * conversation, which loads it from storage.
 */

/**
 * The most turns one run takes (the chat agent's `maxTurns`), a guard that is
 * never reached. The SDK reads the next message before it checks this limit
 * and ends the run without answering that message.
 *
 * A message or action the run reads takes at most one turn, so what follows
 * is an upper bound. One that runs a turn takes one, a refused one included;
 * an action that runs no turn (a begin once the attempt is under way) and a
 * message whose answer the run already holds give theirs back. An attempt's
 * admitted path takes at most 202 at 200: the begin turn, `MAX_STUDENT_TURNS`
 * admitted messages and the one refused at the limit, which closes the
 * session. A message refused for now (sent too soon, say) is not counted
 * against the limit; this leaves room for about 800 of those in one run, which
 * also ends at its compute budget below.
 */
export const QUIZ_RUN_MAX_TURNS = 1_000;

/**
 * The run's `maxDuration`, in seconds of compute. Trigger.dev counts the time
 * a run is working or waiting warm (the idle wait after a turn), not the time
 * it is suspended waiting for a message.
 */
export const QUIZ_RUN_MAX_DURATION_SECONDS = 3_600;

/**
 * The compute a run keeps in hand when it ends between turns: room for one
 * more turn and the wait before it. 240 s for a turn at its deadline (every
 * call and tool of the turn), 10 s of idle wait before it, and 350 s for the
 * work outside that deadline, which nothing bounds (admission, loading the
 * attempt and its material, saving the reply, completing the attempt, the
 * turn's last writes), under a slow database: 600 s.
 */
export const QUIZ_RUN_ROLLOVER_MARGIN_MS = 600_000;

/**
 * The compute after which a run ends once its turn is over: 3,600 s less the
 * 600 s margin, 3,000 s.
 */
export const QUIZ_RUN_COMPUTE_BUDGET_MS =
  QUIZ_RUN_MAX_DURATION_SECONDS * 1_000 - QUIZ_RUN_ROLLOVER_MARGIN_MS;

/** Whether a run that has used `usedMs` of compute ends after this turn. */
export function shouldEndRun(usedMs: number): boolean {
  return usedMs >= QUIZ_RUN_COMPUTE_BUDGET_MS;
}
