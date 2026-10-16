/**
 * The quiz agent's fixed tool set, without executes: the typed UI parts,
 * message validation, and the chat agent's `tools` option (which the SDK uses
 * to convert stored messages, never to call the model). They carry no
 * descriptions: the model never reads these definitions. The quiz agent's
 * task builds its own tools, with their executes and descriptions, and passes
 * those to `streamText`.
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
  OfferNextStepPartSchema,
  PresentQuestionOutputSchema,
  QuestionResultOutputSchema,
  QuizEvaluationFeedbackSchema,
  CodeAwareSandboxQuizQuestionSchema,
  RecordQuestionResultSchema,
} from './schemas.ts';

// The widest input (the optional `code_quote` and `sandbox`), so the typed
// parts cover every mode; each attempt's own tool takes only the fields its
// mode has (the quiz agent's own tools).
const present_question = tool({
  inputSchema: CodeAwareSandboxQuizQuestionSchema,
  outputSchema: PresentQuestionOutputSchema,
});

const record_question_result = tool({
  inputSchema: RecordQuestionResultSchema,
  outputSchema: QuestionResultOutputSchema,
});

// The stored part's input: `feedback` is optional here, for parts saved before
// it was added. The task's own tool (the model's) requires it.
const offer_next_step = tool({
  inputSchema: OfferNextStepPartSchema,
  outputSchema: OfferNextStepOutputSchema,
});

const submit_quiz_evaluation = tool({
  inputSchema: QuizEvaluationFeedbackSchema,
  outputSchema: QuizEvaluationRecordV2Schema,
});

const explore_codebase = tool({
  inputSchema: ExploreCodebaseSchema,
  outputSchema: ExploreCodebaseOutputSchema,
});

const content_get = tool({
  inputSchema: ContentGetSchema,
  outputSchema: ContentToolOutputSchema,
});

const content_search = tool({
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
