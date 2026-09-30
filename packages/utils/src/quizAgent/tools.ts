/**
 * The quiz agent's fixed tool set, without executes. The task spreads each entry
 * and adds its `execute` (`tool({ ...quizToolDefs.present_question, execute })`);
 * the webapp uses the same objects for typed UI parts and message validation.
 * AI SDK v7 requires `outputSchema` on a tool without `execute`.
 */
import { tool } from 'ai';
import { QuizEvaluationRecordV2Schema } from './records.ts';
import {
  ContentGetSchema,
  ContentSearchSchema,
  ContentToolOutputSchema,
  ExploreCodebaseOutputSchema,
  ExploreCodebaseSchema,
  OfferNextStepOutputSchema,
  OfferNextStepSchema,
  PresentQuestionOutputSchema,
  QuestionResultOutputSchema,
  QuizEvaluationFeedbackSchema,
  CodeAwareQuizQuestionSchema,
  RecordQuestionResultSchema,
} from './schemas.ts';

// The code-aware input (with the optional `code_quote`), so the typed parts
// cover both modes; a standard attempt's tool takes the card fields only.
const present_question = tool({
  description:
    'Present a quiz question to the student as a question card. Use this tool for EVERY new question; do not write questions as plain text. Questions are presented in order: the next question number, once the previous question has a recorded result. Any other number is refused. The card shows the question, so do not repeat it in text.',
  inputSchema: CodeAwareQuizQuestionSchema,
  outputSchema: PresentQuestionOutputSchema,
});

const record_question_result = tool({
  description:
    'Record how the student did on a question once they move on from it (a Next click, or a message asking to skip or move on). List every real answer they gave, in order, rate each one with a level, and give the number of hints they had received before it. Clarifying questions about the wording are free and are not answers. The server computes the credit from these ratings. Record each question before presenting the next one or submitting the evaluation. The student does not see this call; they see only the brief feedback.',
  inputSchema: RecordQuestionResultSchema,
  outputSchema: QuestionResultOutputSchema,
});

const offer_next_step = tool({
  description:
    "Show the student buttons for what to do after your feedback on an answer: try_again (answer the same question again) and/or next (move on), with a fixed lead-in line. A click arrives as the student's next message.",
  inputSchema: OfferNextStepSchema,
  outputSchema: OfferNextStepOutputSchema,
});

const submit_quiz_evaluation = tool({
  description:
    'Submit the final quiz evaluation feedback once every question has a recorded result; it is refused until then. Scores are computed from the recorded results. Provide feedback text only.',
  inputSchema: QuizEvaluationFeedbackSchema,
  outputSchema: QuizEvaluationRecordV2Schema,
});

const explore_codebase = tool({
  description:
    'Explore the student\'s repository to find code to ask about. Use focus_area="initial" before the first question, then a specific area when changing topics. Earlier explorations in this attempt are taken into account, so prefer new areas. Returns exact code excerpts; each line starts with its line number ("N| "), which is not part of the code.',
  inputSchema: ExploreCodebaseSchema,
  outputSchema: ExploreCodebaseOutputSchema,
});

const content_get = tool({
  description:
    "Read the full text of one course document by kind and id, as listed under SOURCE MATERIAL or returned by content_search. Documents outside what this quiz may read are refused. The student sees the document's title only.",
  inputSchema: ContentGetSchema,
  outputSchema: ContentToolOutputSchema,
});

const content_search = tool({
  description:
    'Search the course material by meaning. Returns the matching documents with a short snippet each; open one in full with content_get. A miss does not prove the course lacks the topic.',
  inputSchema: ContentSearchSchema,
  outputSchema: ContentToolOutputSchema,
});

export const quizToolDefs = {
  present_question,
  record_question_result,
  offer_next_step,
  submit_quiz_evaluation,
  explore_codebase,
  content_get,
  content_search,
};

export type QuizToolName = keyof typeof quizToolDefs;

/**
 * Fixed tool order (a changed tool list invalidates the prompt cache). An
 * attempt sends the tools it has in this order: the first four always,
 * explore_codebase for a code-aware attempt, and the two content tools when
 * the quiz has linked material or course search and the MCP server is
 * configured. What an attempt has does not change between its turns.
 */
export const QUIZ_TOOL_ORDER = [
  'present_question',
  'record_question_result',
  'offer_next_step',
  'submit_quiz_evaluation',
  'explore_codebase',
  'content_get',
  'content_search',
] as const satisfies readonly QuizToolName[];
