/**
 * Which of a student's quiz attempts counts, and what it scored.
 *
 * One selector for every reader — the student quiz list, the quiz results
 * page, the gradebook, the student report and the student's Assignments
 * page — so they cannot disagree about a student's score.
 *
 *   - Only completed attempts count. An attempt still running never hides one
 *     that finished.
 *   - The score is the attempt's EFFECTIVE percentage (0-100,
 *     `effectivePercentage`): a staff adjustment (`adjusted_emoji`, read
 *     through the classroom's emoji scale like a repo grade) when there is
 *     one, else the AI's `partial_credit_percentage`. A completed attempt with
 *     neither is unscored: it still counts as completed, but it is never the
 *     counting attempt. A 0 is a score.
 *   - HIGHEST: the best effective score (ties: the one completed first), so
 *     an adjusted attempt can become the one that counts.
 *     MOST_RECENT: the latest `completed_at`.
 *     FIRST: the earliest `started_at`.
 *     Any other strategy reads as HIGHEST.
 *
 * Every reader passes the classroom's emoji scale (`emojiMapping.findByClassroomId`,
 * emoji → grade): it is required, so a reader cannot silently score an
 * adjusted attempt at its original percentage.
 */

import { gradeToEmoji } from './grades.ts';
import { gradeBandFor, type GradeBand } from './quizAgent/grading.ts';

/** A classroom's grading scale: emoji shortcode → grade (0-100). `score-N` keys on the numeric scale. */
export type QuizEmojiScale = Readonly<Record<string, number>>;

/** The attempt fields the selector reads. */
export interface ScorableQuizAttempt {
  id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  /** The AI's score. Never edited by staff. */
  partial_credit_percentage: number | null;
  /** A staff adjustment: an emoji on the classroom's scale. Select it wherever attempts are scored. */
  adjusted_emoji?: string | null;
}

/** The attempt fields `effectivePercentage` reads. */
export type AdjustableQuizScore = Pick<
  ScorableQuizAttempt,
  'partial_credit_percentage' | 'adjusted_emoji'
>;

/**
 * The value of a staff adjustment on the classroom's scale, or null when the
 * attempt has none or its emoji is no longer on the scale (removed after the
 * adjustment, like an orphaned repo grade).
 */
export const adjustedPercentage = (
  attempt: Pick<ScorableQuizAttempt, 'adjusted_emoji'>,
  scale: QuizEmojiScale
): number | null => {
  const emoji = attempt.adjusted_emoji;
  if (!emoji || !Object.prototype.hasOwnProperty.call(scale, emoji)) return null;
  const value = scale[emoji];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * The attempt's score (0-100): the staff adjustment read through the
 * classroom's scale when there is one, else the AI's
 * `partial_credit_percentage`. An adjustment whose emoji has left the scale
 * falls back to the AI's score. Null when the attempt has neither.
 */
export const effectivePercentage = (
  attempt: AdjustableQuizScore,
  scale: QuizEmojiScale
): number | null => {
  const adjusted = adjustedPercentage(attempt, scale);
  if (adjusted !== null) return adjusted;
  return typeof attempt.partial_credit_percentage === 'number'
    ? attempt.partial_credit_percentage
    : null;
};

/** One side of an attempt's grade: the number (internal), its emoji and band. */
export interface QuizGradeFace {
  /** 0-100, or null when unscored. Internal: never shown to anyone. */
  percentage: number | null;
  /** The emoji on the classroom's scale, or null when unscored or the scale is empty. */
  emoji: string | null;
  /** The evaluation band from the percentage, or null when unscored. */
  band: GradeBand | null;
}

/** An attempt's grade for display: the AI's original and the effective one. */
export interface QuizAttemptGrade {
  /** The AI's score (`partial_credit_percentage`) as the nearest emoji. */
  original: QuizGradeFace;
  /** What counts: the adjustment when there is one (its own emoji), else the original. */
  effective: QuizGradeFace;
  /** A staff adjustment is in effect (set and still on the scale). */
  adjusted: boolean;
  /** The stored adjustment emoji, in effect or not. */
  adjusted_emoji: string | null;
}

const face = (percentage: number | null, scale: QuizEmojiScale, emoji?: string): QuizGradeFace => ({
  percentage,
  emoji:
    emoji ??
    (percentage !== null && Object.keys(scale).length > 0
      ? gradeToEmoji(percentage, { ...scale })
      : null),
  band: percentage !== null ? gradeBandFor(percentage) : null,
});

/**
 * An attempt's grade as the classroom's emoji (a `score-N` badge on the
 * numeric scale): the original AI score through `gradeToEmoji` (its tie
 * rule), and the effective one. An adjusted attempt shows the adjustment
 * emoji itself, never a re-derived one. The band follows the effective score.
 * Unpenalised: the late penalty applies to totals, after the adjustment.
 */
export const quizAttemptGrade = (
  attempt: AdjustableQuizScore,
  scale: QuizEmojiScale
): QuizAttemptGrade => {
  const original =
    typeof attempt.partial_credit_percentage === 'number'
      ? attempt.partial_credit_percentage
      : null;
  const adjusted = adjustedPercentage(attempt, scale);
  const originalFace = face(original, scale);
  return {
    original: originalFace,
    effective:
      adjusted !== null ? face(adjusted, scale, attempt.adjusted_emoji as string) : originalFace,
    adjusted: adjusted !== null,
    adjusted_emoji: attempt.adjusted_emoji ?? null,
  };
};

/** A percentage as the nearest emoji on the scale (`gradeToEmoji`), or null. */
export const quizPercentageEmoji = (
  percentage: number | null | undefined,
  scale: QuizEmojiScale
): string | null =>
  typeof percentage === 'number' && Number.isFinite(percentage) && Object.keys(scale).length > 0
    ? gradeToEmoji(percentage, { ...scale })
    : null;

const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);

/**
 * The attempt whose score counts under `gradingStrategy`, or null when none is
 * scored. Scores are effective (`effectivePercentage` over `scale`).
 */
export const countingQuizAttempt = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy: string | null | undefined,
  scale: QuizEmojiScale
): T | null => {
  const scoreOf = new Map(attempts.map(a => [a, effectivePercentage(a, scale)]));
  const scored = attempts.filter(a => a.completed_at != null && scoreOf.get(a) != null);
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
      // Every attempt here is scored, so the fallbacks never apply.
      return pick((a, b) => {
        const sa = scoreOf.get(a) ?? 0;
        const sb = scoreOf.get(b) ?? 0;
        return sa > sb || (sa === sb && time(a.completed_at) < time(b.completed_at));
      });
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
  /** The counting attempt's effective percentage (0-100), or null. */
  score: number | null;
}

export const quizStanding = <T extends ScorableQuizAttempt>(
  attempts: readonly T[],
  gradingStrategy: string | null | undefined,
  scale: QuizEmojiScale
): QuizStanding<T> => {
  const counting = countingQuizAttempt(attempts, gradingStrategy, scale);
  const running = attempts.filter(a => a.completed_at == null);
  const inProgress = running.length
    ? running.reduce((newest, a) => (time(a.started_at) > time(newest.started_at) ? a : newest))
    : null;
  return {
    attemptsUsed: attempts.length,
    completed: attempts.some(a => a.completed_at != null),
    inProgress,
    counting,
    score: counting ? effectivePercentage(counting, scale) : null,
  };
};
