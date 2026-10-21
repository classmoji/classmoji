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

/**
 * A question result as a student receives it: no `credit_earned` (a
 * per-question percentage, whose mean is the grade) and no
 * `first_attempt_correct` / `eventually_correct` (which give the
 * first-attempt score back). The grade itself reaches a student as the
 * classroom's emoji only (E1).
 */
export const StudentQuestionResultSchema = StoredQuestionResultSchema.pick({
  question_num: true,
  attempts: true,
  tries: true,
  emoji: true,
  brief_feedback: true,
  revised: true,
  skipped_by_end: true,
});
export type StudentQuestionResult = z.infer<typeof StudentQuestionResultSchema>;

/**
 * The evaluation record as a student receives it (their attempt drawer, the
 * transcript, the live stream): the band and the feedback, without
 * `partial_credit_percentage` / `first_attempt_percentage` and with the
 * question results narrowed (`StudentQuestionResultSchema`). Parsing strips
 * every other key.
 */
export const QuizEvaluationRecordStudentSchema = QuizEvaluationRecordV2Schema.omit({
  partial_credit_percentage: true,
  first_attempt_percentage: true,
  question_results: true,
}).extend({ question_results: z.array(StudentQuestionResultSchema) });
export type QuizEvaluationRecordStudent = z.infer<typeof QuizEvaluationRecordStudentSchema>;

/**
 * What a results panel renders from: the student's record, or staff's full
 * one (whose extra numbers only colour the question cards).
 */
export type QuizEvaluationRecordView = QuizEvaluationRecordStudent &
  Partial<Pick<QuizEvaluationRecordV2, 'partial_credit_percentage' | 'first_attempt_percentage'>> & {
    question_results: Array<
      StudentQuestionResult &
        Partial<
          Pick<StoredQuestionResult, 'credit_earned' | 'eventually_correct' | 'first_attempt_correct'>
        >
    >;
  };

const STUDENT_RECORD_KEYS = ['v', 'source', 'feedback', 'evaluation', 'numeric_score'] as const;
const STUDENT_RESULT_KEYS = Object.keys(StudentQuestionResultSchema.shape);

const pickKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));

/**
 * A stored record narrowed for a student, or null when it is not one (`v: 2`).
 * A record the schema refuses (stored under an older shape) is still narrowed,
 * key by key, rather than dropped: the student keeps their results panel and
 * still gets no number.
 */
export const studentEvaluationRecord = (
  record: QuizEvaluationRecordV2 | null | undefined
): QuizEvaluationRecordStudent | null => {
  if (!record || typeof record !== 'object' || (record as { v?: unknown }).v !== 2) return null;
  const parsed = QuizEvaluationRecordStudentSchema.safeParse(record);
  if (parsed.success) return parsed.data;
  const raw = record as unknown as Record<string, unknown>;
  const results = Array.isArray(raw.question_results) ? raw.question_results : [];
  return {
    ...pickKeys(raw, STUDENT_RECORD_KEYS),
    question_results: results
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map(r => pickKeys(r, STUDENT_RESULT_KEYS)),
  } as QuizEvaluationRecordStudent;
};
