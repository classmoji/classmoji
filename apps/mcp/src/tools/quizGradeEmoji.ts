/**
 * Quiz grades as emoji, for the staff quiz-attempt reads (list_quiz_attempts,
 * get_quiz_attempt). The MCP states a grade as an emoji on the classroom's own
 * scale, never as a number: on an emoji scale the nearest mapped emoji, on the
 * numeric scale the nearest `score-N` badge (`gradeToEmoji`).
 *
 * A classroom with no scale gets the default one, as quiz grading does
 * (`loadEmojiMappings` in quizGrading.service): each question's stored emoji
 * was picked on that same scale, so the attempt's emoji and its questions'
 * agree.
 */

import { ClassmojiService } from '@classmoji/services';
import { DEFAULT_EMOJI_GRADE_MAPPINGS, gradeToEmoji } from '@classmoji/utils';

/** A classroom's scale: emoji shortcode → the grade (0–100) it stands for. */
export type EmojiScale = Record<string, number>;

/** The classroom's emoji scale, or the default one when it has none. */
export async function loadQuizEmojiScale(classroomId: string): Promise<EmojiScale> {
  const mappings = (await ClassmojiService.emojiMapping.findByClassroomId(
    classroomId
  )) as EmojiScale;
  return Object.keys(mappings ?? {}).length > 0 ? mappings : { ...DEFAULT_EMOJI_GRADE_MAPPINGS };
}

/** A 0–100 grade as the scale's nearest emoji; null when there is no grade. */
export const emojiFor = (grade: number | null | undefined, scale: EmojiScale): string | null =>
  typeof grade === 'number' && Number.isFinite(grade) ? gradeToEmoji(grade, scale) : null;
