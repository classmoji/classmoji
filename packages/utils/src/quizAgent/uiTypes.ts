/**
 * The quiz chat's UIMessage type and the schemas of its data parts. Types + Zod
 * only; imported by the task, the services and the webapp.
 */
import type { InferUITools, UIMessage, UIMessageChunk } from 'ai';
import { z } from 'zod';
import { QuizEvaluationRecordV2Schema } from './records.ts';
import type { quizToolDefs } from './tools.ts';

export const QuestionResultDataSchema = z.object({
  question_num: z.number(),
  emoji: z.string(),
  brief_feedback: z.string(),
  revised: z.literal(true).optional(),
});

/** A label for one exploration read: the file path only, never why it was read. */
export const StepDataSchema = z.object({
  kind: z.literal('read_file'),
  path: z.string(),
  error: z.literal(true).optional(),
});

export const NOTICE_CODES = [
  'turn_stopped',
  'source_material_unavailable',
  'reply_failed',
  'refused',
] as const;

export const NoticeDataSchema = z.object({ code: z.enum(NOTICE_CODES) });

/** Every data part the quiz agent may send; the projection drops any other. */
export const quizDataPartSchemas = {
  'question-result': QuestionResultDataSchema,
  step: StepDataSchema,
  notice: NoticeDataSchema,
  /** Written only when the server completes the attempt from the recorded results. */
  evaluation: QuizEvaluationRecordV2Schema,
};

export type QuizDataParts = {
  'question-result': z.infer<typeof QuestionResultDataSchema>;
  step: z.infer<typeof StepDataSchema>;
  notice: z.infer<typeof NoticeDataSchema>;
  evaluation: z.infer<typeof QuizEvaluationRecordV2Schema>;
};

export type QuizMessageMetadata = {
  /** The whole message is internal (the opening "begin" message). */
  hidden?: true;
  /** Internal parts of a visible message (the per-turn status part). */
  hiddenPartIndexes?: number[];
  /** Set by admission when the student's text is exactly a button's text. */
  action?: 'next' | 'try_again';
};

export type QuizUITools = InferUITools<typeof quizToolDefs>;
export type QuizUIMessage = UIMessage<QuizMessageMetadata, QuizDataParts, QuizUITools>;
export type QuizUIMessagePart = QuizUIMessage['parts'][number];
export type QuizUIMessageChunk = UIMessageChunk<QuizMessageMetadata, QuizDataParts>;

/** The fixed text a button click sends as the student's message. */
export const BUTTON_TEXT = {
  try_again: "I'd like to try answering this question again",
  next: 'next',
} as const;
