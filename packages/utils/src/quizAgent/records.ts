/**
 * Stored shapes: a question result entry in quiz_attempts.question_results_json
 * and the evaluation record in quiz_attempts.evaluation_json.
 */
import { z } from 'zod';
import { GRADE_BAND_LABELS } from './grading.ts';
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
  /** Only on a result revised before results became final; older attempts still carry it. */
  revised: z.literal(true).optional(),
  /** Recorded as skipped by the server when the student ended the quiz early. */
  skipped_by_end: z.literal(true).optional(),
  recorded_at: z.string(),
});
export type StoredQuestionResult = z.infer<typeof StoredQuestionResultSchema>;

export const QuizEvaluationRecordV2Schema = z.object({
  v: z.literal(2),
  source: z.enum(['model', 'server']),
  /**
   * The model's closing feedback, `final_acknowledgment` included (shown above
   * the results). Its `evaluation` and `numeric_score` are the server's band.
   * Absent when the server completed the attempt from the recorded results.
   */
  feedback: QuizEvaluationFeedbackSchema.omit({
    quiz_complete: true,
    ended_early: true,
  }).optional(),
  /**
   * The evaluation band from `partial_credit_percentage` (`gradeBandFor`), set
   * by the server on every completion, the server's own included. Absent only
   * on records stored before it was added.
   */
  evaluation: z.enum(GRADE_BAND_LABELS).optional(),
  numeric_score: z.number().int().min(1).max(4).optional(),
  partial_credit_percentage: z.number(),
  first_attempt_percentage: z.number(),
  question_results: z.array(StoredQuestionResultSchema.omit({ recorded_at: true })),
});
export type QuizEvaluationRecordV2 = z.infer<typeof QuizEvaluationRecordV2Schema>;
