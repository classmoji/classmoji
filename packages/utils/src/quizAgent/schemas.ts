/**
 * Tool input and output schemas for quiz attempts run as chat agents. Shared by
 * the Trigger task (tool definitions and executes), the grading service and the
 * webapp (rendering). No server imports: this reaches the client bundle.
 */
import { z } from 'zod';
import { ANSWER_LEVELS } from './grading.ts';

/** Tool-schema, prompt and grading-policy bundle an attempt is stamped with. */
export const CONTRACT_VERSION = 1;

export const QuizQuestionSchema = z.object({
  preamble: z
    .string()
    .describe(
      'A brief, natural lead-in to the question (1-2 sentences). Examples: "I noticed something interesting in your SearchBar component.", "Let me ask you about your error handling approach.", "Based on what I found in your code..."'
    ),
  question_number: z.number().int().min(1).describe('Current question number (1-indexed)'),
  total_questions: z.number().int().min(1).describe('Total number of questions in this quiz'),
  question_text: z
    .string()
    .min(1, 'question_text must not be empty')
    .describe(
      'The actual question being asked to the student. IMPORTANT: Do NOT include code here if you are providing code_snippet - the UI renders code_snippet separately in a styled box above this text.'
    ),
  code_snippet: z
    .string()
    .optional()
    .describe(
      'Optional code snippet relevant to the question. This is rendered in a separate styled code box ABOVE the question_text, so do NOT repeat or reference this code in question_text with phrases like "Look at this code snippet:" - the UI handles displaying it.'
    ),
  code_language: z
    .string()
    .optional()
    .describe('Programming language for syntax highlighting (e.g., "javascript", "python", "tsx")'),
  context: z
    .string()
    .optional()
    .describe(
      'One short line naming what the question is about. For code: the file name and the rule, element or function the question asks about, e.g. "style.css — .highlight-grid" or "auth.js — login()". Otherwise the concept.'
    ),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

/** The most lines one code quote may show: its ranges, less the omitted lines. */
export const MAX_QUOTE_LINES = 40;
/** The most separate ranges one code quote may join. */
export const MAX_QUOTE_RANGES = 8;

/**
 * Lines of the student's file for a question card, by line number. The server
 * reads the file and fills the card's code from it, so the code is exact and
 * every cut is marked. Code-aware attempts only.
 */
export const CodeQuoteSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .describe("The file's path in the repository, exactly as your exploration results name it."),
  ranges: z
    .array(
      z.array(z.number().int().min(1)).length(2).describe('[first line, last line], both included')
    )
    .min(1)
    .max(MAX_QUOTE_RANGES)
    .describe(
      `Line ranges to show, as [start, end] pairs of the line numbers in your exploration results: ascending, not overlapping, at most ${MAX_QUOTE_LINES} lines shown in all. Quote whole CSS rules and HTML elements where you can. A "..." line marks each gap between ranges, and a quote that starts or stops inside a rule or element.`
    ),
  omit: z
    .array(z.number().int().min(1))
    .max(MAX_QUOTE_LINES)
    .optional()
    .describe(
      'Line numbers inside a range to leave out (never its first or last line). Each run of left-out lines shows as one "..." line.'
    ),
  anchor: z
    .string()
    .min(1)
    .max(400)
    .describe(
      'The text of the first quoted line (the first line of the first range), without its line number. It is checked against the file.'
    ),
  edit: z
    .object({
      line: z.number().int().min(1).describe('A quoted line number'),
      replace: z.string().max(400).describe('The new text of that one line'),
    })
    .optional()
    .describe(
      'Only for the one question that asks the student to find a change you made to their code: one quoted line replaced with new text. At most one question per quiz; a second is refused. For any other "what if" question, quote the real code and describe the change in words.'
    ),
});
export type CodeQuote = z.infer<typeof CodeQuoteSchema>;

/**
 * present_question's input for a code-aware attempt: the card, plus
 * `code_quote` for code from the student's repository.
 */
export const CodeAwareQuizQuestionSchema = QuizQuestionSchema.extend({
  code_quote: CodeQuoteSchema.optional().describe(
    'Use this to show the student\'s code: the server fills the card\'s code with the exact lines and the "..." markers, in place of code_snippet. Leave code_snippet out when you use it.'
  ),
});
export type CodeAwareQuizQuestion = z.infer<typeof CodeAwareQuizQuestionSchema>;

/** Where a card's code came from, when the server filled it from a code quote. */
export const QuoteSourceSchema = z.object({
  path: z.string(),
  /** The quoted line ranges: "5-10", "7", or "5-10, 20-24". */
  lines: z.string(),
  /** True when `edit` changed one line. */
  changed: z.boolean(),
});
export type QuoteSource = z.infer<typeof QuoteSourceSchema>;

/** The card as stored and shown: the question, plus `source` for a quoted card. */
export const QuestionCardSchema = QuizQuestionSchema.extend({
  source: QuoteSourceSchema.optional(),
});
export type QuestionCard = z.infer<typeof QuestionCardSchema>;

export const AnswerSchema = z.object({
  level: z
    .enum(ANSWER_LEVELS)
    .describe(
      'How good this answer was. correct: Correct. mostly_right: the right idea, one small gap or imprecision. partly_right: some correct reasoning, a key piece missing. minimal: relevant but mostly wrong. no_attempt: skipped or nothing meaningful.'
    ),
  hints_before: z
    .number()
    .int()
    .min(0)
    .describe(
      'How many hints the student had received for this question before giving this answer. Every hint counts: each Try again click and each hint request gives exactly one hint. Never lower than the previous answer.'
    ),
});

export const RecordQuestionResultSchema = z.object({
  question_num: z.number().int().min(1).describe('The question number (1-indexed)'),
  answers: z
    .array(AnswerSchema)
    .refine(
      a => a.every((x, i) => i === 0 || x.hints_before >= a[i - 1].hints_before),
      'hints_before must not decrease'
    )
    .describe(
      'Every real answer the student gave to this question, in order. Empty when the question was skipped. A clarifying question about the wording is not an answer. Answers given after the answer was revealed are not listed.'
    ),
  brief_feedback: z
    .string()
    .min(1)
    .max(100)
    .describe('One line of feedback shown with the progress marker, at most 100 characters'),
  student_asked_to_move_on: z
    .boolean()
    .optional()
    .describe(
      "true only when the student's latest message itself asks to skip this question, move on or end the quiz. Leave it out after a Next click. An answer, even a correct one, is not a request to move on."
    ),
});
export type RecordQuestionResult = z.infer<typeof RecordQuestionResultSchema>;

/**
 * Port of the ai-agent's QuizEvaluationFeedbackSchema: the model supplies the
 * feedback text only; scores come from the recorded results.
 */
export const QuizEvaluationFeedbackSchema = z.object({
  final_acknowledgment: z
    .string()
    .min(1, 'final_acknowledgment must not be empty')
    .describe(
      "Your closing words to the student, shown above their results: a brief, warm acknowledgment of the student's final answer. This should feel natural and encouraging. Write them here, not as text before the call."
    ),
  quiz_complete: z
    .literal(true, {
      errorMap: () => ({ message: 'quiz_complete must be true to submit evaluation' }),
    })
    .describe('Must be true to indicate quiz completion'),
  // Optional and never refused: the server sets both from the recorded score
  // (`gradeBandFor`), whatever the model sends.
  evaluation: z
    .string()
    .optional()
    .describe(
      'Optional. Grade level evaluation: EXCELLENT, GOOD, NEEDS WORK, or UNSATISFACTORY. The server sets it from the recorded score.'
    ),
  numeric_score: z
    .number()
    .optional()
    .describe(
      'Optional. Numeric score on 1-4 scale: EXCELLENT=4, GOOD=3, NEEDS WORK=2, UNSATISFACTORY=1. The server sets it from the recorded score.'
    ),
  feedback_summary: z
    .string()
    .min(1, 'feedback_summary must not be empty')
    .describe('One sentence overall assessment focused on understanding and mastery'),
  feedback_strengths: z
    .array(z.string())
    .describe('List of concepts/mental models the student has mastered'),
  feedback_improvements: z
    .array(z.string())
    .describe('List of concepts/models the student should review or practice more'),
  feedback_recommendation: z
    .string()
    .min(1, 'feedback_recommendation must not be empty')
    .describe('Specific next steps for achieving mastery'),
  feedback_effort_note: z
    .string()
    .min(1, 'feedback_effort_note must not be empty')
    .describe('Comment on learning journey and persistence shown'),
});
export type QuizEvaluationFeedback = z.infer<typeof QuizEvaluationFeedbackSchema>;

export const NEXT_STEP_ACTIONS = ['next', 'try_again'] as const;
export type NextStepAction = (typeof NEXT_STEP_ACTIONS)[number];

export const OfferNextStepSchema = z.object({
  actions: z
    .array(z.enum(NEXT_STEP_ACTIONS))
    .min(1)
    .max(2)
    .refine(a => new Set(a).size === a.length, 'actions must not repeat')
    .describe(
      'The buttons to show: try_again (answer the same question again) and/or next (move on)'
    ),
});
export type OfferNextStep = z.infer<typeof OfferNextStepSchema>;

/**
 * offer_next_step's output: the buttons, and the fixed line shown with them,
 * chosen by the server from the buttons and whether the question is the last
 * one (`nextStepLeadIn`).
 */
export const OfferNextStepOutputSchema = OfferNextStepSchema.extend({
  lead_in: z.string(),
});
export type OfferNextStepOutput = z.infer<typeof OfferNextStepOutputSchema>;

/** The ai-agent's ExplorationRequestSchema minus previousFindings/avoidFiles (history comes from the journal). */
export const ExploreCodebaseSchema = z.object({
  purpose: z
    .enum(['check_current', 'prepare_next'])
    .describe(
      "check_current: re-read the student's code for the question they are on, to judge an answer or check a quote they dispute. " +
        'prepare_next: find code for the next question; refused while the current question has no recorded result (allowed before the first question).'
    ),
  focus_area: z
    .string()
    .max(200)
    .describe(
      'What to explore: "initial" for project overview, or specific areas like "authentication", "state_management", "api", "testing", or a custom description'
    ),
  specific_question: z
    .string()
    .max(500)
    .optional()
    .describe('Optional specific question to answer about the code'),
  depth: z
    .enum(['shallow', 'focused', 'deep'])
    .default('focused')
    .describe('shallow=structure only, focused=key files (default), deep=thorough analysis'),
});
export type ExploreCodebaseInput = z.input<typeof ExploreCodebaseSchema>;

export const PresentQuestionOutputSchema = z.object({
  card: QuestionCardSchema,
  question_number: z.number(),
  total_questions: z.number(),
});
export type PresentQuestionOutput = z.infer<typeof PresentQuestionOutputSchema>;

export const QuestionResultOutputSchema = z.object({
  question_num: z.number(),
  emoji: z.string(),
  brief_feedback: z.string(),
  revised: z.literal(true).optional(),
});
export type QuestionResultOutput = z.infer<typeof QuestionResultOutputSchema>;

export const ExploreCodebaseOutputSchema = z.object({
  excerpts: z.string(),
  files_read: z.array(z.string()),
});
export type ExploreCodebaseOutput = z.infer<typeof ExploreCodebaseOutputSchema>;

/**
 * `content_get`: one course document, by the kind and id the SOURCE MATERIAL
 * block or a content_search hit names. The task adds the classroom itself;
 * the model never names one.
 */
export const ContentGetSchema = z.object({
  kind: z
    .enum(['page', 'slide', 'file'])
    .describe("Document kind: 'page', 'slide' (a deck) or 'file' (a course note)"),
  id: z
    .string()
    .min(1)
    .max(400)
    .describe('Document id, as listed under SOURCE MATERIAL or returned by content_search'),
});
export type ContentGetInput = z.infer<typeof ContentGetSchema>;

/** `content_search`: what to look for in the course material, in plain language. */
export const ContentSearchSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(500)
    .describe('What to look for, in plain language (a question works well)'),
});
export type ContentSearchInput = z.infer<typeof ContentSearchSchema>;

/** Both content tools answer the model in plain text. */
export const ContentToolOutputSchema = z.string();
