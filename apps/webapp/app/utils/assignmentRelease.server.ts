import { openAssignmentInExistingRepos } from '@classmoji/tasks/assignment-release';

type Released = { release_at?: Date | string | null };

const time = (value: Date | string | null | undefined) =>
  value == null ? null : new Date(value).getTime();

/**
 * Whether an assignment edit may have released a REPO assignment into the
 * student repos that already exist: it published it, or moved its release
 * date. An unpublish never does (a past `release_at` would otherwise re-open
 * and re-publish it at once). Weight, deadline and text edits never do.
 *
 * `before` is the row as it was; `updates` the fields the edit sent. The edit
 * form sends `release_at` on every save, so it counts only when it changed.
 */
export const editMayRelease = (
  before: { type: string; is_published: boolean } & Released,
  updates: { is_published?: unknown; release_at?: unknown }
): boolean => {
  if (before.type !== 'REPO') return false;
  if (updates.is_published === false) return false;
  const published = updates.is_published === true && before.is_published !== true;
  const moved =
    updates.release_at !== undefined &&
    time(updates.release_at as Date | string | null) !== time(before.release_at);
  return published || moved;
};

/**
 * Put a just-published (or just-released) REPO assignment into the student
 * repos that already exist, as the module card's Publish does. Returns a note
 * for the toast when that could not be started; null otherwise (including when
 * there was nothing to do: a draft repository, a future release date).
 */
export const openInExistingRepos = async (
  classroomId: string,
  assignmentId: string,
  reposWord: string
): Promise<string | null> => {
  try {
    await openAssignmentInExistingRepos({ classroomId, assignmentId });
    return null;
  } catch (error: unknown) {
    console.error('[assignments] Opening the assignment in student repos failed:', error);
    return `It could not be added to student ${reposWord} yet. Use Sync on the repository to try again.`;
  }
};
