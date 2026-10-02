/**
 * Which of a student's quiz attempts counts, and what it scored.
 *
 * One selector for every reader — the student quiz list, the quiz results
 * page, the gradebook, the student report and the student's Assignments
 * page — so they cannot disagree about a student's score.
 *
 *   - Only completed attempts count. An attempt still running never hides one
 *     that finished.
 *   - The score is `partial_credit_percentage` (0-100). A completed attempt
 *     with no percentage is unscored: it still counts as completed, but it is
 *     never the counting attempt. A 0 is a score.
 *   - HIGHEST: the best score (ties: the one completed first).
 *     MOST_RECENT: the latest `completed_at`.
 *     FIRST: the earliest `started_at`.
 *     Any other strategy reads as HIGHEST.
 */

/** The attempt fields the selector reads. */
export interface ScorableQuizAttempt {
  id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  partial_credit_percentage: number | null;
}

const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);

const isScored = (a: ScorableQuizAttempt) =>
  a.completed_at != null && typeof a.partial_credit_percentage === 'number';

/** The attempt whose score counts under `gradingStrategy`, or null when none is scored. */
export const countingQuizAttempt = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy?: string | null
): T | null => {
  const scored = attempts.filter(isScored);
  if (scored.length === 0) return null;

  const pick = (better: (a: T, b: T) => boolean) =>
    scored.reduce((best, a) => (better(a, best) ? a : best));

  switch (gradingStrategy) {
    case 'MOST_RECENT':
      return pick(
        (a, b) =>
          time(a.completed_at) > time(b.completed_at) ||
          (time(a.completed_at) === time(b.completed_at) && time(a.started_at) > time(b.started_at))
      );
    case 'FIRST':
      return pick(
        (a, b) =>
          time(a.started_at) < time(b.started_at) ||
          (time(a.started_at) === time(b.started_at) && time(a.completed_at) < time(b.completed_at))
      );
    case 'HIGHEST':
    default:
      return pick(
        (a, b) =>
          a.partial_credit_percentage! > b.partial_credit_percentage! ||
          (a.partial_credit_percentage === b.partial_credit_percentage &&
            time(a.completed_at) < time(b.completed_at))
      );
  }
};

/** One student's standing on one quiz, from their attempts. */
export interface QuizStanding<T extends ScorableQuizAttempt> {
  /** Every attempt, finished or not. */
  attemptsUsed: number;
  /** At least one attempt has completed, scored or not. */
  completed: boolean;
  /** The newest attempt that has not completed, if any: the one to resume. */
  inProgress: T | null;
  /** The attempt that counts, or null when no completed attempt is scored. */
  counting: T | null;
  /** The counting attempt's percentage (0-100), or null. */
  score: number | null;
}

export const quizStanding = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy?: string | null
): QuizStanding<T> => {
  const counting = countingQuizAttempt(attempts, gradingStrategy);
  const running = attempts.filter(a => a.completed_at == null);
  const inProgress = running.length
    ? running.reduce((newest, a) => (time(a.started_at) > time(newest.started_at) ? a : newest))
    : null;
  return {
    attemptsUsed: attempts.length,
    completed: attempts.some(a => a.completed_at != null),
    inProgress,
    counting,
    score: counting?.partial_credit_percentage ?? null,
  };
};
