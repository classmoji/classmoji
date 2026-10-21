/**
 * Quiz grades as emoji, for every MCP read that states one (list_quiz_attempts,
 * get_quiz_attempt, my_grades, list_quizzes, the regrade lists). The MCP states
 * a grade as an emoji on the classroom's own scale, never as a number (E6): on
 * an emoji scale the nearest mapped emoji, on the numeric scale the nearest
 * `score-N` badge (`gradeToEmoji`, through `quizPercentageEmoji`).
 *
 * The scale is `emojiMapping.findScaleByClassroomId`, the one the web pages and
 * the grade totals read, so an adjusted attempt's emoji is worth here what it
 * is worth everywhere. A classroom with no scale has no emoji: every grade
 * reads null, as on the web (`quizAttemptGrade` / `quizPercentageEmoji` give
 * null on an empty scale). An adjusted attempt shows its adjustment emoji
 * itself, never one re-derived from its value (`quizAttemptGrade`).
 */

import { ClassmojiService } from '@classmoji/services';
import {
  quizAttemptGrade,
  quizPercentageEmoji,
  type AdjustableQuizScore,
  type QuizAttemptGrade,
} from '@classmoji/utils';

/** A classroom's scale: emoji shortcode → the grade (0–100) it stands for. */
export type EmojiScale = Record<string, number>;

/** The classroom's emoji scale; empty when it has none. */
export async function loadQuizEmojiScale(classroomId: string): Promise<EmojiScale> {
  return (await ClassmojiService.emojiMapping.findScaleByClassroomId(classroomId)) ?? {};
}

/** A 0–100 grade as the scale's nearest emoji; null when there is no grade or no scale. */
export const emojiFor = (grade: number | null | undefined, scale: EmojiScale): string | null =>
  quizPercentageEmoji(grade, scale);

/** An attempt's grade (original and effective emoji, adjusted flag) on the scale. */
export const attemptGrade = (attempt: AdjustableQuizScore, scale: EmojiScale): QuizAttemptGrade =>
  quizAttemptGrade(attempt, scale);

/** The adjustment columns a student's own quiz grade reads. */
export interface StudentAdjustedAttempt extends AdjustableQuizScore {
  instructor_comment?: string | null;
  adjusted_by?: { name?: string | null } | null;
}

/**
 * A student's own grade on one attempt, as their quiz result shows it (D6):
 * the grade that counts as an emoji, whether staff adjusted it and the AI's
 * original emoji when they did, and the instructor's comment with the name of
 * who wrote it. Nothing about staff beyond that name, and no number.
 */
export const studentQuizGradeView = (
  attempt: StudentAdjustedAttempt | null | undefined,
  scale: EmojiScale
) => {
  if (!attempt) {
    return {
      emoji: null,
      adjusted: false,
      original_emoji: null,
      instructor_comment: null,
      instructor_name: null,
    };
  }
  const grade = quizAttemptGrade(attempt, scale);
  const comment = attempt.instructor_comment ?? null;
  return {
    emoji: grade.effective.emoji,
    adjusted: grade.adjusted,
    original_emoji: grade.adjusted ? grade.original.emoji : null,
    instructor_comment: comment,
    instructor_name: comment ? (attempt.adjusted_by?.name ?? null) : null,
  };
};
