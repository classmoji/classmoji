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
    .describe('Brief context about what file/concept this question relates to'),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

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
      "A brief, warm acknowledgment of the student's final answer before presenting the evaluation. This should feel natural and encouraging."
    ),
  quiz_complete: z
    .literal(true, {
      errorMap: () => ({ message: 'quiz_complete must be true to submit evaluation' }),
    })
    .describe('Must be true to indicate quiz completion'),
  evaluation: z
    .string()
    .min(1, 'evaluation must not be empty')
    .describe('Grade level evaluation: EXCELLENT, GOOD, NEEDS WORK, or UNSATISFACTORY'),
  numeric_score: z
    .number()
    .int()
    .min(1)
    .max(4)
    .describe('Numeric score on 1-4 scale: EXCELLENT=4, GOOD=3, NEEDS WORK=2, UNSATISFACTORY=1'),
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
  card: QuizQuestionSchema,
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
