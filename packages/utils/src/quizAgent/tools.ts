/**
 * The quiz agent's fixed tool set, without executes: the typed UI parts,
 * message validation, and the chat agent's `tools` option (which the SDK uses
 * to convert stored messages, never to call the model). The model never reads
 * these descriptions: the task builds its own tools with their executes
 * (packages/tasks, agents/quiz/tools) and passes those to `streamText`. Both
 * take their descriptions from `TOOL_DESCRIPTIONS`, the one copy of that text.
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
import { TOOL_DESCRIPTIONS } from './toolDescriptions.ts';

// The code-aware input (with the optional `code_quote`), so the typed parts
// cover both modes; a standard attempt's tool takes the card fields only.
const present_question = tool({
  description: TOOL_DESCRIPTIONS.present_question,
  inputSchema: CodeAwareQuizQuestionSchema,
  outputSchema: PresentQuestionOutputSchema,
});

const record_question_result = tool({
  description: TOOL_DESCRIPTIONS.record_question_result,
  inputSchema: RecordQuestionResultSchema,
  outputSchema: QuestionResultOutputSchema,
});

const offer_next_step = tool({
  description: TOOL_DESCRIPTIONS.offer_next_step,
  inputSchema: OfferNextStepSchema,
  outputSchema: OfferNextStepOutputSchema,
});

const submit_quiz_evaluation = tool({
  description: TOOL_DESCRIPTIONS.submit_quiz_evaluation,
  inputSchema: QuizEvaluationFeedbackSchema,
  outputSchema: QuizEvaluationRecordV2Schema,
});

const explore_codebase = tool({
  description: TOOL_DESCRIPTIONS.explore_codebase,
  inputSchema: ExploreCodebaseSchema,
  outputSchema: ExploreCodebaseOutputSchema,
});

const content_get = tool({
  description: TOOL_DESCRIPTIONS.content_get,
  inputSchema: ContentGetSchema,
  outputSchema: ContentToolOutputSchema,
});

const content_search = tool({
  description: TOOL_DESCRIPTIONS.content_search,
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
