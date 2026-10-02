/**
 * The one rule for whether a student can see an assignment.
 *
 * Every student surface asks this same question — the Assignments page, the
 * dashboard, the Modules page, the calendar and its ICS feed — so the answer
 * lives here, once. Staff surfaces never filter on it: they show everything
 * and use it only to mark what students cannot see yet.
 *
 *   - The assignment itself must be published.
 *   - QUIZ and FORM assignments open at `release_at`, checked at read time.
 *     REPO assignments keep their scheduled release: the release job flips
 *     `is_published` when `release_at` passes, so reading `release_at` here
 *     could hide a repo assignment an owner published by hand.
 *   - REPO: its repository must be published too (until then no student repo
 *     exists to submit through).
 *   - QUIZ: only where the classroom has quizzes, and not while the quiz is a
 *     DRAFT. A CLOSED quiz stays visible, so a student keeps seeing the quiz
 *     they finished, with its score.
 *   - FORM: not while the form is a DRAFT. A CLOSED form stays visible and
 *     reads as closed.
 *
 * Module publish is not part of the rule; it governs only the Modules page.
 */

/** The fields the rule reads. Structural, so any assignment query that selects them fits. */
export interface AssignmentVisibilityInput {
  type: string;
  is_published: boolean;
  release_at?: Date | string | null;
  repository?: { is_published: boolean } | null;
  quiz?: { status: string } | null;
  form?: { status: string } | null;
}

export interface AssignmentVisibilityContext {
  /** Whether this classroom shows quizzes at all (Pro, switched on). */
  quizzesVisible: boolean;
}

const toTime = (value: Date | string | number) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** Whether `release_at` has passed. An empty one means "open when published". */
export const isReleased = (releaseAt: Date | string | null | undefined, now: Date | number) =>
  releaseAt == null || toTime(releaseAt) <= toTime(now);

export const openToStudents = (
  assignment: AssignmentVisibilityInput,
  now: Date | number,
  { quizzesVisible }: AssignmentVisibilityContext
): boolean => {
  if (!assignment.is_published) return false;

  switch (assignment.type) {
    case 'REPO':
      return assignment.repository?.is_published === true;
    case 'QUIZ':
      return (
        quizzesVisible &&
        isReleased(assignment.release_at, now) &&
        !!assignment.quiz &&
        assignment.quiz.status !== 'DRAFT'
      );
    case 'FORM':
      return (
        isReleased(assignment.release_at, now) &&
        !!assignment.form &&
        assignment.form.status !== 'DRAFT'
      );
    default:
      return false;
  }
};
