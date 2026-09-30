/**
 * Stored shapes: a question result entry in quiz_attempts.question_results_json
 * and the evaluation record in quiz_attempts.evaluation_json.
 */
import { z } from 'zod';
import { QuizEvaluationFeedbackSchema } from './schemas.ts';

/**
 * One entry of question_results_json for a trigger_chat attempt. `attempts`
 * equals `tries` and is kept for the readers of older attempts. The per-answer
 * levels and hint counts stay in the attempt's journal only.
 */
export const StoredQuestionResultSchema = z.object({
  question_num: z.number().int().min(1),
  attempts: z.number().int().min(0),
  tries: z.number().int().min(0),
  eventually_correct: z.boolean(),
  first_attempt_correct: z.boolean(),
  credit_earned: z.number().min(0).max(100),
  emoji: z.string(),
  brief_feedback: z.string(),
  revised: z.literal(true).optional(),
  recorded_at: z.string(),
});
export type StoredQuestionResult = z.infer<typeof StoredQuestionResultSchema>;

export const QuizEvaluationRecordV2Schema = z.object({
  v: z.literal(2),
  source: z.enum(['model', 'server']),
  /** Absent when the server completed the attempt from the recorded results. */
  feedback: QuizEvaluationFeedbackSchema.omit({ quiz_complete: true }).optional(),
  partial_credit_percentage: z.number(),
  first_attempt_percentage: z.number(),
  question_results: z.array(StoredQuestionResultSchema.omit({ recorded_at: true })),
});
export type QuizEvaluationRecordV2 = z.infer<typeof QuizEvaluationRecordV2Schema>;
