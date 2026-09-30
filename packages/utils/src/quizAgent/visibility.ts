/**
 * The quiz agent's projection registry: what every viewer sees of each tool and
 * data part (see agents/projection.ts). Typed against the static tool set and the
 * data parts, so a missing entry is a type error.
 */
import type { Registry } from '../agents/projection.ts';
import type { CodeAwareQuizQuestion } from './schemas.ts';
import type { QuizToolName } from './tools.ts';
import { quizDataPartSchemas, type QuizDataParts } from './uiTypes.ts';

export const quizVisibility = {
  tools: {
    present_question: 'shown',
    offer_next_step: 'shown',
    submit_quiz_evaluation: 'shown',
    record_question_result: 'hidden',
    explore_codebase: 'label',
    // The query names the next question and the output is course text: the
    // task writes a `course_material` step (a title at most) instead.
    content_get: 'label',
    content_search: 'label',
  },
  dataParts: quizDataPartSchemas,
  // The card renders from present_question's output, which the server fills
  // from `code_quote`; the quote's own terms stay with the server.
  hiddenInputKeys: {
    present_question: ['code_quote'] satisfies (keyof CodeAwareQuizQuestion)[],
  },
} as const satisfies Registry<QuizToolName, keyof QuizDataParts & string>;
