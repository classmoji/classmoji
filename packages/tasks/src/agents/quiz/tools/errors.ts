/**
 * What a failed quiz tool call tells the model.
 *
 * A thrown error becomes the tool's `tool-error` result, which the model reads
 * and corrects in the same turn. The browser never gets that text: the UI
 * stream replaces every tool error with "An error occurred.", the saved reply
 * carries that same text, and the chat renders no failed tool part. The text
 * is still kept to three kinds, since the model reads it: a grading refusal,
 * whose message the grading service writes for the model (it says what is
 * accepted), a code-quote refusal (codeQuote.ts: what to fix, quoting at most
 * one line of the student's own file), or fixed text. Nothing else (database
 * errors, stack traces, request bodies, GitHub answers) is passed on; those
 * are logged as ids and error facts only.
 */
import type { QuizToolName } from '@classmoji/utils/quiz-agent';
import { logDiagnostic, type DiagnosticLog } from '../../shared/sanitize.ts';

export const TURN_STOPPED_TEXT = 'This turn was stopped. Nothing was saved.';

/** offer_next_step refused because a question card went out earlier in the same turn. */
export const OFFER_AFTER_QUESTION_TEXT =
  "Wait for the student's answer to this question before offering next steps.";

/**
 * offer_next_step refused in a turn the student opened with Try again: that
 * turn is a hint, which ends with a question and waits for their answer. A
 * code-aware hint may still re-read the code first (explore_codebase with
 * purpose check_current), so only the two calls that end a turn are named.
 */
export const OFFER_AFTER_HINT_TEXT =
  'This is a hint turn: write the hint as your reply text, with no offer_next_step or present_question. Give exactly one hint and end with a question such as "What do you think?".';

/**
 * present_question refused: it would show the current question's card again
 * in a turn the student opened with Try again. The card would end the turn,
 * and the hint the student asked for would never be written.
 */
export const RESHOW_ON_HINT_TEXT =
  'This is a hint turn: give the hint as text; don\'t show the question again. If your reply already gives the hint, end it there; otherwise give exactly one hint and end with a question such as "What do you think?".';

/** offer_next_step refused because buttons already went out in this turn. */
export const OFFER_TWICE_TEXT =
  'Your feedback and the buttons are already shown. End your reply now.';

/** offer_next_step refused for Try again without Next: the student can always move on. */
export const OFFER_TRY_AGAIN_ALONE_TEXT =
  'Offer ["try_again", "next"] or ["next"]: the student can always move on.';

/**
 * present_question refused: it would show the current question's card again
 * after the model has already written text in this turn, so a feedback turn
 * would end with the old card and no buttons.
 */
export const RESHOW_AFTER_TEXT =
  "You already replied this turn; don't re-show the question. If the student answered, call offer_next_step with your feedback in its feedback field.";

/**
 * `RESHOW_AFTER_TEXT` for question `lastPresented`. With no question open (it
 * has its result), the model most likely meant the next one, so it is named.
 */
export const reshowAfterText = (lastPresented: number, questionOpen: boolean) =>
  questionOpen
    ? RESHOW_AFTER_TEXT
    : `${RESHOW_AFTER_TEXT} To show the next question, send question_number ${lastPresented + 1}.`;

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
  'The student has not moved on from this question. Record it only after they click Next, or when their latest message asks to skip or move on (then set student_asked_to_move_on). If they answered, call offer_next_step with your feedback in its feedback field; otherwise just reply.';

/** present_question refused: question `n`'s card already shows edited code, and a quiz gets one. */
export const editLimitText = (n: number) =>
  `Only one question per quiz may show edited code, and question ${n} already does. Quote the real code without edit and describe any change in words in question_text.`;

/** present_question refused because question `n`, the one still open, has no result yet. */
export const recordBeforePresentText = (n: number) =>
  `Question ${n} has no result. If the student moved on from it (Next, or asked to skip), record it first, then present; otherwise reply without presenting.`;

/** present_question refused because the file a code quote names could not be read. */
export const QUOTE_READ_FAILED_TEXT =
  'The file could not be read just now. Call present_question again; if that fails too, put the lines in code_snippet instead, copied exactly from your exploration output without their "N| " prefixes, and name the file and the rule or element in context.';

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
