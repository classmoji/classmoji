/**
 * What a failed quiz tool call tells the model.
 *
 * A thrown error becomes the tool's `tool-error` result, which the model reads
 * and corrects. For the `shown` tools (present_question, offer_next_step,
 * submit_quiz_evaluation) that error text also reaches the browser, so it is
 * always one of three kinds: a grading refusal, whose message the grading
 * service writes for the model (it says what is accepted), a code-quote
 * refusal (codeQuote.ts: what to fix, quoting at most one line of the
 * student's own file), or fixed text. Nothing else (database errors, stack
 * traces, request bodies, GitHub answers) is passed on; those are logged as
 * ids and error facts only.
 */
import type { QuizToolName } from '@classmoji/utils/quiz-agent';
import { logDiagnostic, type DiagnosticLog } from '../../shared/sanitize.ts';

export const TURN_STOPPED_TEXT = 'This turn was stopped. Nothing was saved.';

/** offer_next_step refused because a question card went out earlier in the same turn. */
export const OFFER_AFTER_QUESTION_TEXT =
  "Wait for the student's answer to this question before offering next steps.";

/**
 * offer_next_step refused because the model has written no visible text in
 * this turn yet. It says to call again: a model that only writes the feedback
 * after this would end the turn without buttons.
 */
export const OFFER_BEFORE_FEEDBACK_TEXT =
  "Write your feedback on the student's answer first (what is right, what is wrong if anything, and why it matters), then call offer_next_step again as the last thing in this reply.";

/** The `code` on that refusal, so the loop can tell it from every other one. */
export const FEEDBACK_MISSING = 'feedback_missing';

/**
 * The refusal of offer_next_step for no feedback text yet. The loop may run
 * such a call again at the end of the turn once the text is there (loop.ts).
 */
export function feedbackMissingError(): Error {
  return Object.assign(new Error(OFFER_BEFORE_FEEDBACK_TEXT), { code: FEEDBACK_MISSING });
}

/** True for the refusal `feedbackMissingError` makes, and for nothing else. */
export function isFeedbackMissing(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === FEEDBACK_MISSING;
}

/**
 * offer_next_step refused in a turn the student opened with Try again: that
 * turn is a hint, which ends with a question and waits for their answer.
 */
export const OFFER_AFTER_HINT_TEXT =
  'The student clicked Try again, so this reply is a hint: give exactly one hint, end with a question such as "What do you think?", and wait for their answer. No buttons after a hint.';

/** offer_next_step refused for Try again without Next: the student can always move on. */
export const OFFER_TRY_AGAIN_ALONE_TEXT =
  'Offer ["try_again", "next"] or ["next"]: the student can always move on.';

/** present_question refused because next-step buttons went out earlier in the same turn. */
export const QUESTION_AFTER_OFFER_TEXT =
  "Wait for the student's choice before presenting the next question.";

/** record_question_result refused for a question whose card went out earlier in the same turn. */
export const RECORD_BEFORE_ANSWER_TEXT =
  'The student has not answered this question yet. Wait for their answer.';

/**
 * record_question_result refused for the question the student is still on:
 * no Next click, and the call does not say they asked to move on.
 */
export const RECORD_BEFORE_NEXT_TEXT =
  'The student has not moved on from this question. Record it only after they click Next, or when their latest message asks to skip or move on (then set student_asked_to_move_on). After an answer, write your feedback and call offer_next_step.';

/** present_question refused: question `n`'s card already shows edited code, and a quiz gets one. */
export const editLimitText = (n: number) =>
  `Only one question per quiz may show edited code, and question ${n} already does. Quote the real code without edit and describe any change in words in question_text.`;

/** present_question refused because question `n`, the one the student is leaving, has no result yet. */
export const recordBeforePresentText = (n: number) =>
  `Record question ${n} before presenting the next one.`;

/** present_question refused because the file a code quote names could not be read. */
export const QUOTE_READ_FAILED_TEXT =
  'The file could not be read just now. Call present_question again; if that fails too, use code_snippet with the lines copied exactly from your exploration.';

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
