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
 *   - QUIZ: only where the classroom has quizzes. The assignment owns the
 *     quiz's publish state, so nothing on the quiz itself is read. A quiz
 *     past its close date (`closes_at`) stays visible, so a student keeps
 *     seeing the quiz they finished, with its score; it only takes no new
 *     attempt (see `isClosed`).
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

/**
 * Whether a REPO assignment belongs on student repos now, i.e. gets its
 * submission row (and issue) when a repo is created or synced. A scheduled one
 * goes out once `release_at` passes. One with no `release_at` has no schedule:
 * it goes out once published, and a draft without a date stays a draft.
 */
export const releasedToRepos = (
  assignment: { release_at?: Date | string | null; is_published?: boolean | null },
  now: Date | number
) =>
  assignment.release_at == null
    ? assignment.is_published === true
    : isReleased(assignment.release_at, now);

/**
 * Whether a close date has passed: from `closes_at` on, no new attempt can
 * start. An empty one means "never closes".
 */
export const isClosed = (closesAt: Date | string | null | undefined, now: Date | number) =>
  closesAt != null && toTime(closesAt) <= toTime(now);

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
      return quizzesVisible && isReleased(assignment.release_at, now);
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
