import { isClosed, isReleased } from '@classmoji/utils';
import dayjs from 'dayjs';

/** Said to a teaching assistant who posts a write only the owner or a teacher may make. */
export const QUIZ_AUTHOR_ONLY = 'Only the class owner or a teacher can do this.';

/**
 * The list's status for a quiz, from its assignment, as the quiz form's panel
 * reads it: Draft until published, Scheduled while its Opens date is ahead,
 * Closed once its close date has passed, Published otherwise. A quiz with no
 * assignment is in no module.
 */
export type QuizListStatus = 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'CLOSED' | 'NO_MODULE';

export const quizListStatus = (
  assignment:
    | {
        is_published: boolean;
        closes_at: Date | string | null;
        release_at?: Date | string | null;
      }
    | null
    | undefined,
  now: Date
): QuizListStatus => {
  if (!assignment) return 'NO_MODULE';
  if (!assignment.is_published) return 'DRAFT';
  if (!isReleased(assignment.release_at, now)) return 'SCHEDULED';
  return isClosed(assignment.closes_at, now) ? 'CLOSED' : 'PUBLISHED';
};

/** The short date the list names beside Scheduled, as the form's pill does. */
export const scheduledLabel = (releaseAt: Date | string | null) =>
  releaseAt ? `Scheduled · ${dayjs(releaseAt).format('ddd MMM D · h:mm A')}` : 'Scheduled';

/** The list's delete confirm: the quiz, its attempts and its place in a module go. */
export const deleteQuizCopy = (moduleTitle: string | null) =>
  moduleTitle
    ? `This deletes the quiz and every attempt at it, and removes it from ${moduleTitle}.`
    : 'This deletes the quiz and every attempt at it.';

/** The list's publish confirm: when students get the quiz (its Opens date, when still ahead). */
export const publishQuizCopy = (releaseAt: string | Date | null, now: Date = new Date()) =>
  releaseAt && dayjs(releaseAt).isAfter(now)
    ? `Students get this quiz on ${dayjs(releaseAt).format('ddd MMM D · h:mm A')}.`
    : 'This will make the quiz available to all students.';
