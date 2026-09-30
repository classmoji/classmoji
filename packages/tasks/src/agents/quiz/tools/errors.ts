/**
 * What a failed quiz tool call tells the model.
 *
 * A thrown error becomes the tool's `tool-error` result, which the model reads
 * and corrects. For the `shown` tools (present_question, offer_next_step,
 * submit_quiz_evaluation) that error text also reaches the browser, so it is
 * always one of two kinds: a grading refusal, whose message the grading
 * service writes for the model (it says what is accepted), or fixed text.
 * Nothing else (database errors, stack traces, request bodies) is passed on;
 * those are logged as ids and error facts only.
 */
import type { QuizToolName } from '@classmoji/utils/quiz-agent';
import { logDiagnostic, type DiagnosticLog } from '../../shared/sanitize.ts';

export const TURN_STOPPED_TEXT = 'This turn was stopped. Nothing was saved.';

/** offer_next_step refused because a question card went out earlier in the same turn. */
export const OFFER_AFTER_QUESTION_TEXT =
  "Wait for the student's answer to this question before offering next steps.";

/** present_question refused because next-step buttons went out earlier in the same turn. */
export const QUESTION_AFTER_OFFER_TEXT =
  "Wait for the student's choice before presenting the next question.";

/** record_question_result refused for a question whose card went out earlier in the same turn. */
export const RECORD_BEFORE_ANSWER_TEXT =
  'The student has not answered this question yet. Wait for their answer.';

/** present_question refused because question `n`, the one the student is leaving, has no result yet. */
export const recordBeforePresentText = (n: number) =>
  `Record question ${n} before presenting the next one.`;

/** A grading refusal from `ClassmojiService.quizGrading` (`QuizGradingError`). */
export function isGradingRefusal(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    error.name === 'QuizGradingError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

export function retryText(tool: QuizToolName): string {
  return `${tool} could not be completed just now. Call it again with the same input.`;
}

/**
 * The error to throw from a tool's execute: the refusal's own message, or
 * fixed text for anything unexpected. Either way one diagnostic line is logged.
 */
export function toolFailure(
  tool: QuizToolName,
  error: unknown,
  ids: { attemptId: string; runId: string },
  log?: DiagnosticLog
): Error {
  logDiagnostic(tool, error, { chatId: ids.attemptId, runId: ids.runId }, log);
  if (isGradingRefusal(error)) return new Error(error.message);
  return new Error(retryText(tool));
}

/** True when either signal has aborted. */
export function aborted(...signals: Array<AbortSignal | undefined>): boolean {
  return signals.some(s => s?.aborted);
}
