import { createContext, useContext, type ReactNode } from 'react';
import type { AttemptGradeView } from '~/utils/quizPayloads';
import Emoji from '~/components/ui/display/Emoji';

/**
 * What an attempt drawer adds to the results panel it renders deep inside
 * (`QuizResults` in the chat runtime, `QuizEvaluation` in the legacy one):
 *
 *   - `grade`: the attempt's grade as the classroom's emoji (E3), from the
 *     drawer's loader. Null while the loader has not seen the attempt
 *     completed (a quiz finishing in this session): the panel then shows the
 *     band alone, never a number (E1).
 *   - `headerExtra`: the right side of the evaluation card's header (the
 *     student's "Request regrade/resubmit" button or its status).
 *   - `beforeResults`: blocks above "Quiz Complete!" (the staff adjust panel
 *     and request banner; the student's instructor comment and request
 *     outcome).
 */
export interface QuizResultSlots {
  grade: AttemptGradeView | null;
  headerExtra?: ReactNode;
  beforeResults?: ReactNode;
}

const QuizResultContext = createContext<QuizResultSlots | null>(null);

export const QuizResultProvider = QuizResultContext.Provider;

export const useQuizResultSlots = (): QuizResultSlots | null => useContext(QuizResultContext);

/**
 * The band label the card shows: the effective grade's (D9) when the drawer
 * has it, else the stored evaluation's.
 */
export const effectiveBand = (
  slots: QuizResultSlots | null,
  stored: { evaluation?: string | null; numeric_score?: number | null }
): { evaluation: string | null; numeric_score: number | null } =>
  slots?.grade?.band
    ? { evaluation: slots.grade.band.evaluation, numeric_score: slots.grade.band.numeric_score }
    : { evaluation: stored.evaluation ?? null, numeric_score: stored.numeric_score ?? null };

/**
 * The large grade at the top of the results card (E3): the effective emoji
 * and its band, "adjusted from <original>" when staff adjusted it (D6), and
 * what it counts for when late. With no grade (see `QuizResultSlots`), the
 * band alone.
 */
export function QuizGradeHero({ band }: { band: string | null }) {
  const slots = useQuizResultSlots();
  const grade = slots?.grade ?? null;
  return (
    <div
      className="mb-5 flex flex-col items-center gap-1 text-center"
      data-testid="quiz-grade-hero"
    >
      {grade?.emoji && (
        <span data-testid="quiz-grade-hero-emoji" className="leading-none">
          <Emoji emoji={grade.emoji} fontSize={64} />
        </span>
      )}
      {band && (
        <div className="text-sm font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
          {band}
        </div>
      )}
      {grade?.adjusted && grade.originalEmoji && (
        <div
          data-testid="quiz-grade-hero-adjusted"
          className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300"
        >
          <Emoji emoji={grade.emoji ?? ''} fontSize={16} />
          <span>adjusted from</span>
          <Emoji emoji={grade.originalEmoji} fontSize={16} />
        </div>
      )}
      {grade?.countedEmoji && (
        <div
          data-testid="quiz-grade-hero-counted"
          className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"
        >
          <span>Counted</span>
          <Emoji emoji={grade.countedEmoji} fontSize={16} />
          {typeof grade.lateHours === 'number' && grade.lateHours > 0 && (
            <span>· {grade.lateHours}h late</span>
          )}
        </div>
      )}
      {!grade?.countedEmoji && typeof grade?.lateHours === 'number' && grade.lateHours > 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400">{grade.lateHours}h late</div>
      )}
    </div>
  );
}
