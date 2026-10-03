/**
 * The quiz agent's projection registries: what each viewer sees of each tool
 * and data part (see agents/projection.ts). Typed against the static tool set
 * and the data parts, so a missing entry is a type error.
 *
 * `quizVisibility` is the student's view, and every live stream's: the
 * attempt's owner drives the chat, so it is also the owner's view on reload.
 * `quizStaffVisibility` is for staff reading someone else's attempt: the same,
 * except that it keeps offer_next_step's `expected_answer`.
 */
import type { Registry } from '../agents/projection.ts';
import type { CodeAwareQuizQuestion, OfferNextStep } from './schemas.ts';
import type { QuizToolName } from './tools.ts';
import { quizDataPartSchemas, type QuizDataParts } from './uiTypes.ts';

const tools = {
  present_question: 'shown',
  offer_next_step: 'shown',
  submit_quiz_evaluation: 'shown',
  record_question_result: 'hidden',
  explore_codebase: 'label',
  // The query names the next question and the output is course text: the
  // task writes a `course_material` step (a title at most) instead.
  content_get: 'label',
  content_search: 'label',
} as const;

// The card renders from present_question's output, which the server fills
// from `code_quote`; the quote's own terms stay with the server.
const codeQuote = ['code_quote'] as const satisfies readonly (keyof CodeAwareQuizQuestion)[];

export const quizVisibility = {
  tools,
  dataParts: quizDataPartSchemas,
  hiddenInputKeys: {
    present_question: codeQuote,
    // The correct answer, for staff only. A call with a hidden key sends no
    // streamed input, so the feedback appears once the call is complete.
    offer_next_step: ['expected_answer'] satisfies (keyof OfferNextStep)[],
  },
} as const satisfies Registry<QuizToolName, keyof QuizDataParts & string>;

export const quizStaffVisibility = {
  tools,
  dataParts: quizDataPartSchemas,
  hiddenInputKeys: { present_question: codeQuote },
} as const satisfies Registry<QuizToolName, keyof QuizDataParts & string>;
