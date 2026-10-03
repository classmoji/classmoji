/**
 * The quiz tools' descriptions as the model reads them: the one copy, used by
 * the task's tools (packages/tasks, agents/quiz/tools) and by `quizToolDefs`.
 * They sit in the tools block at the very front of the cached prefix, so they
 * are fixed text: no per-quiz or per-turn value ever goes in here. They say
 * what the tools enforce; the prompt (packages/tasks, agents/quiz/prompt) says
 * the rest. Change them together.
 *
 * Keyed by tool name. Not typed by `QuizToolName`: that type comes from
 * `quizToolDefs`, which reads this object. Every tool in `tools.ts` takes its
 * description from here, and a test checks there is no other key.
 */
import { BUTTON_TEXT } from './uiTypes.ts';

export const TOOL_DESCRIPTIONS = {
  present_question:
    'Show a new question as a card: the only way to ask one. Send the number CURRENT STATUS names as next; the previous question must already have its recorded result. ' +
    'Resending the current number re-shows its card and ends your turn: do that only if the student asks to see the question again, at the start of your reply. ' +
    'Do not repeat the question in text or write after it; never call offer_next_step in the same reply. ' +
    'Success ends your turn; on a refusal, do what it says (usually fix the call and call again).',

  record_question_result:
    "Record a question's result when the student moves on from it: a Next click, or their message asking to skip or move on (then set student_asked_to_move_on). " +
    'Call it first in that turn, before any prepare_next exploration, present_question or submit_quiz_evaluation. ' +
    'An answer, even a correct one, is not moving on; recording then is refused. ' +
    'List each real answer in order (see answers); [] if they skipped without answering. ' +
    'A recorded result is final. ' +
    'The server scores; never mention the result.',

  offer_next_step:
    "Give your feedback on the student's answer and show the buttons, in one call. " +
    'State the correct answer in `expected_answer` (staff only; the student never sees it), then put the feedback in `feedback`; write no other text in the reply, because the feedback is shown as your message. ' +
    'The feedback says what is right, what is wrong and why; with Try again offered it gives no direction toward the answer, since guidance comes only as a hint after a Try again click. ' +
    'Buttons: ["try_again","next"] if not correct or "I don\'t know", ["next"] if correct or after you revealed the answer. It ends your turn. ' +
    'Never after a question card, a hint (a Try again turn is always a hint), a clarifying or side question, bare agreement, or a letter-only answer to a question that asks for an explanation: those end with your text. ' +
    'The buttons bring their own lead-in; never mention them or tell the student what to click or type. ' +
    `A click arrives as the next message: "${BUTTON_TEXT.try_again}" or "${BUTTON_TEXT.next}".`,

  submit_quiz_evaluation:
    'Submit closing feedback after the student moved on from the last question and you recorded it. ' +
    'Refused until every question has a recorded result (the error lists the missing ones), unless the student confirmed ending early: then set ended_early. ' +
    'The server sets scores and band: send feedback text only, leave evaluation and numeric_score out. ' +
    'Closing words go in final_acknowledgment, not text; write nothing after it.',

  explore_codebase:
    'Read the student\'s repository via a faster assistant that returns exact excerpts; each line starts "N| " (its line number, not code; use it in code_quote). ' +
    'purpose prepare_next: code for the next question, before question 1 (focus_area "initial") or once the current question is recorded; refused while one is open. ' +
    "purpose check_current: re-read code for the open question (judge an answer, check a disputed quote, or code the student mentions that you haven't seen). " +
    'One at a time, at most 3 per turn, failures included. ' +
    "Don't re-explore an area you have; an empty result means continue with what you have. " +
    'On failure retry once, then follow IF explore_codebase FAILS.',

  content_get:
    'Read one course document in full by the kind and id a SOURCE MATERIAL header or content_search hit gives: when a listed document was cut, or to check what the course says before asking or grading. ' +
    'Not for a document already shown in full. ' +
    'Without course search only listed documents can be read; never retry a refused one. ' +
    'At most 3 lookups per turn with content_search. ' +
    'The student sees only its title.',

  content_search:
    'Search the course material by meaning, phrased as a question: to check the course covers a topic before asking about it, or before calling a claim outside the material. ' +
    'Its scope (the listed documents or the whole course) is as the SOURCE MATERIAL or COURSE SEARCH block says. ' +
    'Returns up to 5 hits (kind, id, title, snippet); open one with content_get. ' +
    'A miss does not prove absence; "could not run" is not a miss. ' +
    'At most 3 lookups per turn with content_get. ' +
    'The student never sees your query.',
};
