/**
 * The quiz tools' descriptions as the model reads them. They sit in the tools
 * block at the very front of the cached prefix, so they are fixed text: no
 * per-quiz or per-turn value ever goes in here. They say the same thing as the
 * prompt (prompt/base.ts, prompt/codeAware.ts); change them together.
 */
import { BUTTON_TEXT, type QuizToolName } from '@classmoji/utils/quiz-agent';

export const TOOL_DESCRIPTIONS: Record<QuizToolName, string> = {
  present_question:
    "Put a new quiz question on the student's screen as a question card. Use it for EVERY new question; never write a question as plain text, and do not repeat it in your text. " +
    'Send the question number the CURRENT STATUS names as next, once the previous question has a recorded result; any other number is refused and the error says which one is accepted. ' +
    'Your turn ends when it succeeds, so write nothing after it and never call offer_next_step with it: the student answers the question first.',

  record_question_result:
    'Record how a question went when the student moves on from it: a Next click, or a message of theirs asking to skip or move on (then set student_asked_to_move_on). ' +
    'An answer, even a correct one, is not moving on: it gets your feedback and offer_next_step, and a result recorded before the student moves on is refused. ' +
    'List every real answer the student gave to this question, in order, each rated with a level and the number of hints they had received for this question before it; an empty list when they skipped without answering. ' +
    'Clarifying questions and bare agreement are not answers; "I don\'t know" is an answer rated no_attempt. Each Try again click or hint request is one hint. Answers after you revealed the answer are not listed. ' +
    'The server computes the score. Call it before presenting the next question or submitting the evaluation. The student sees only the brief feedback and an emoji; do not mention either.',

  offer_next_step:
    'Show the student buttons after your feedback on an answer: ["try_again", "next"] when the answer is not correct or after "I don\'t know", ["next"] when it is correct or after you revealed the answer. ' +
    'The buttons come with their own fixed lead-in line (such as "Ready for the next question?"), so do not write one yourself, and never tell the student what to click or what comes next ("Click Next to see your results"). ' +
    'Never in the same reply as present_question: after a new question the student answers first, and the call is refused. ' +
    'Never after a hint: a Try again click or a hint request gets one hint ending with a question such as "What do you think?", and the call is refused in a Try again turn. ' +
    'Write your feedback text first (2 to 4 sentences: what is right, what is wrong if anything, and why it matters), then call it as the last thing in your reply and end the reply; a call before that feedback is refused. ' +
    `A click arrives as the student's next message: "${BUTTON_TEXT.try_again}" or "${BUTTON_TEXT.next}".`,

  submit_quiz_evaluation:
    'Submit your closing feedback once the student has moved on from the last question and every question has a recorded result; it is refused until then and names the questions still missing one. ' +
    'Scores and the evaluation band are computed from the recorded results: provide feedback text only. Your closing words go in final_acknowledgment, shown above the results; do not also write them as text. Write nothing after it succeeds.',

  explore_codebase:
    "Explore the student's repository to find code to ask about: a faster assistant picks the relevant files and returns exact excerpts. " +
    'Use focus_area="initial" before the first question, then a specific area (or a file and the part of it you need) when changing topics. ' +
    'Earlier explorations in this attempt are taken into account, so prefer new areas. One exploration at a time. ' +
    'Each excerpt line starts with its line number in the file ("N| "), which is not part of the code; quote lines in a question card by these numbers (present_question code_quote). ' +
    'If a call fails, call it at most once more; never tell the student about a failure.',

  content_get:
    'Read the full text of one course document by its kind and id, as a SOURCE MATERIAL header or a content_search hit names them. ' +
    "Use it when a listed document's text was cut, or to check what the course says before you ask or grade. " +
    'A document this quiz may not read is refused; do not retry it. ' +
    "The student sees only the document's title, never your reason for reading it.",

  content_search:
    'Search the course material by meaning; ask the way a person would (a question works well). ' +
    'Returns the best matching documents, each with its kind, id, title and a short snippet; open one in full with content_get. ' +
    'A miss does not prove the course lacks the topic, and a search that could not run is not an empty result. ' +
    'The student never sees your query.',
};
