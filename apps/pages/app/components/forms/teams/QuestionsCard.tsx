import { Fragment, type ReactNode } from 'react';

import { QUESTIONS_CARD_LABELS, SETUP_ROW_IDS } from './teamsView.ts';
import type { SetupQuestion } from './types.ts';

/**
 * Setup's Questions card: a row per question of the form (QuestionRow), what
 * each one does in the set and how much it counts.
 *
 * The page renders each row (`renderRow`), so every row can save through its
 * own fetcher: one shared fetcher would drop a row's save when another row
 * posts before it answers. The card is the list's frame and its empty state.
 *
 * Presentational: props in, nothing out.
 */

export interface QuestionsCardProps {
  /** SetupView.questions, in form order. */
  questions: readonly SetupQuestion[];
  /** One `<li>` per question (a QuestionRow); keyed here by field id. */
  renderRow: (question: SetupQuestion) => ReactNode;
}

export function QuestionsCard({ questions, renderRow }: QuestionsCardProps) {
  return (
    <section
      id={SETUP_ROW_IDS.questions}
      aria-labelledby="questions-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h2 id="questions-heading" className="text-sm font-semibold text-gray-900 dark:text-white">
          {QUESTIONS_CARD_LABELS.heading}
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {QUESTIONS_CARD_LABELS.subheading}
        </span>
      </div>
      {questions.length > 0 ? (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {questions.map(question => (
            <Fragment key={question.field_id}>{renderRow(question)}</Fragment>
          ))}
        </ul>
      ) : (
        <div className="py-12 text-center text-gray-500">
          <div className="font-medium">{QUESTIONS_CARD_LABELS.emptyTitle}</div>
          <div className="text-sm">{QUESTIONS_CARD_LABELS.emptyText}</div>
        </div>
      )}
    </section>
  );
}

export default QuestionsCard;
