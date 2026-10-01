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
  /** Only on a result revised before results became final; older attempts still carry it. */
  revised: z.literal(true).optional(),
});

/** A label for one exploration read: the file path only, never why it was read. */
export const ReadFileStepSchema = z.object({
  kind: z.literal('read_file'),
  path: z.string(),
  error: z.literal(true).optional(),
});

/** Longest document title a course-material step carries: a label, not a payload. */
export const COURSE_STEP_TITLE_MAX = 200;

/**
 * A label for one course-material lookup: the title of the document read
 * (content_get), or nothing at all for a search (its query is the model's
 * next question). Never the query, the document's id or its text.
 */
export const CourseMaterialStepSchema = z.object({
  kind: z.literal('course_material'),
  title: z.string().min(1).max(COURSE_STEP_TITLE_MAX).optional(),
});

/** One step of the work behind a reply, shown above it. */
export const StepDataSchema = z.discriminatedUnion('kind', [
  ReadFileStepSchema,
  CourseMaterialStepSchema,
]);

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
  /** Set by admission when the student's text names a button (`buttonActionFor`). */
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

/** A message that is just "try again", with any trailing punctuation. */
const TYPED_TRY_AGAIN = /^try\s+again[.!?…]*$/;

/**
 * The button a student message's text names: a button's text, trimmed and in
 * any case (a typed "Next" is the Next button), or a message that is just
 * "try again" (trailing punctuation allowed), which the prompt takes as a Try
 * again click too. Admission tags the message with it; the chat reads it to
 * know that a message used up the buttons.
 */
export function buttonActionFor(text: string): 'next' | 'try_again' | undefined {
  const typed = text.trim().toLowerCase();
  if (typed === BUTTON_TEXT.try_again.toLowerCase() || TYPED_TRY_AGAIN.test(typed)) {
    return 'try_again';
  }
  if (typed === BUTTON_TEXT.next.toLowerCase()) return 'next';
  return undefined;
}

/**
 * Whether the reply to a Try again click showed the student a hint: one of
 * its parts is text that is not blank, and none is a notice. A reply that was
 * stopped part way counts once it has text; one that failed or ran out of
 * time (it carries a notice), or that shows no text, does not.
 *
 * The one rule for both sides of a Try again click: the server raises an
 * answer's hint count for each click whose reply this holds for
 * (`floorHintsAtTryAgain` in quizGrading.service), and the chat ends exactly
 * those replies with Next alone and gives the clicked set back after any
 * other (`buttonSetsOf` in QuizChat). Takes stored parts (JSON) or a
 * message's parts.
 */
export function replyShowsHint(parts: readonly unknown[]): boolean {
  const objects = parts.filter(
    (p): p is { type?: unknown; text?: unknown } => typeof p === 'object' && p !== null
  );
  return (
    !objects.some(p => p.type === 'data-notice') &&
    objects.some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '')
  );
}

/** The fixed line shown with the buttons (the previous runtime's wording). */
export const NEXT_STEP_LEAD_IN = {
  /** Next only, with another question to come. */
  next: 'Ready for the next question?',
  /** Next only, on the last question: moving on shows the results. */
  results: 'Ready to see your results?',
  /** Try again and Next. */
  try_again_or_next: 'Would you like to try again or move on?',
} as const;

/**
 * The lead-in for a set of buttons, or null for a set that has none (Try
 * again alone: the student can always move on, so it is never offered).
 */
export function nextStepLeadIn(
  actions: readonly ('next' | 'try_again')[],
  isLastQuestion: boolean
): string | null {
  if (!actions.includes('next')) return null;
  if (actions.includes('try_again')) return NEXT_STEP_LEAD_IN.try_again_or_next;
  return isLastQuestion ? NEXT_STEP_LEAD_IN.results : NEXT_STEP_LEAD_IN.next;
}
