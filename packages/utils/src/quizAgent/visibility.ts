/**
 * The quiz agent's projection registry: what every viewer sees of each tool and
 * data part (see agents/projection.ts). Typed against the static tool set and the
 * data parts, so a missing entry is a type error.
 */
import type { Registry } from '../agents/projection.ts';
import type { QuizToolName } from './tools.ts';
import { quizDataPartSchemas, type QuizDataParts } from './uiTypes.ts';

export const quizVisibility = {
  tools: {
    present_question: 'shown',
    offer_next_step: 'shown',
    submit_quiz_evaluation: 'shown',
    record_question_result: 'hidden',
    explore_codebase: 'label',
  },
  dataParts: quizDataPartSchemas,
} as const satisfies Registry<QuizToolName, keyof QuizDataParts & string>;
