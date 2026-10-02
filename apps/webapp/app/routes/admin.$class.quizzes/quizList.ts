import { isClosed } from '@classmoji/utils';

/** Said to a teaching assistant who posts a write only the owner or a teacher may make. */
export const QUIZ_AUTHOR_ONLY = 'Only the class owner or a teacher can do this.';

/**
 * The list's status for a quiz, from its assignment: Draft until published,
 * Closed once its close date has passed, Published otherwise. A quiz with no
 * assignment is in no module.
 */
export type QuizListStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED' | 'NO_MODULE';

export const quizListStatus = (
  assignment: { is_published: boolean; closes_at: Date | string | null } | null | undefined,
  now: Date
): QuizListStatus => {
  if (!assignment) return 'NO_MODULE';
  if (!assignment.is_published) return 'DRAFT';
  return isClosed(assignment.closes_at, now) ? 'CLOSED' : 'PUBLISHED';
};
