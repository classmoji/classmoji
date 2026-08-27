import type { BellNotification, NotificationRole } from './NotificationBell';

type Role = NotificationRole;

const STUDENT_NOTIFICATION_TYPES = new Set([
  'QUIZ_PUBLISHED',
  'PAGE_PUBLISHED',
  'PAGE_UNPUBLISHED',
  'REPOSITORY_PUBLISHED',
  'REPOSITORY_UNPUBLISHED',
  'ASSIGNMENT_DUE_DATE_CHANGED',
  'ASSIGNMENT_GRADED',
]);

const ASSISTANT_NOTIFICATION_TYPES = new Set(['TA_GRADING_ASSIGNED', 'TA_REGRADE_ASSIGNED']);

const rolePrefix = (role: Role): string => {
  if (role === 'STUDENT') return 'student';
  if (role === 'ASSISTANT') return 'assistant';
  if (role === 'TEACHER') return 'teacher';
  return 'admin';
};

/**
 * Most privileged first — the same order `resolveHighestMembership` uses in
 * packages/auth. Selecting by priority rather than by whichever role happens to
 * come first in the caller's array is what makes the chosen prefix stable: a
 * user holding several roles in one classroom would otherwise get a different
 * link depending on the order the memberships were queried in.
 */
const ROLE_PRIORITY: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

const highestRole = (roles: Role[]): Role | null =>
  ROLE_PRIORITY.find(role => roles.includes(role)) ?? null;

const roleForNotification = (type: string, roles: Role[]): Role | null => {
  if (roles.length === 0) return null;
  // A notification aimed at a specific role is read in that role's view, even
  // when the reader also holds a higher one.
  if (STUDENT_NOTIFICATION_TYPES.has(type) && roles.includes('STUDENT')) return 'STUDENT';
  if (ASSISTANT_NOTIFICATION_TYPES.has(type) && roles.includes('ASSISTANT')) return 'ASSISTANT';
  return highestRole(roles);
};

/**
 * Build a deep link for a notification given the user's role in that classroom.
 * Returns null when we don't know how to link the resource (the bell will
 * still mark it read on click but won't navigate).
 */
export const notificationLink = (
  n: Pick<BellNotification, 'type' | 'resource_type' | 'resource_id' | 'classroom' | 'metadata'>,
  roles: Role[] | null | undefined
): string | null => {
  const role = roleForNotification(n.type, roles ?? []);
  if (!n.classroom || !role) return null;
  const prefix = rolePrefix(role);
  const slug = n.classroom.slug;

  switch (n.resource_type) {
    case 'quiz':
      // The quiz detail page exists in every staff route tree — admin, teacher
      // and assistant all serve the management screens. Only students land on
      // the list, because the student tree has no detail page.
      return prefix === 'student'
        ? `/${prefix}/${slug}/quizzes`
        : `/${prefix}/${slug}/quizzes/${n.resource_id}`;
    case 'assignment':
      // Only the student route tree has an assignments list page.
      return prefix === 'student' ? `/${prefix}/${slug}/assignments` : `/${prefix}/${slug}`;
    case 'repository':
      return `/${prefix}/${slug}/repos`;
    case 'page':
      return `/${prefix}/${slug}/pages/${n.resource_id}`;
    case 'git_repo_assignment':
      // The grading queue exists under the assistant and teacher route trees.
      return prefix === 'assistant' || prefix === 'teacher'
        ? `/${prefix}/${slug}/grading`
        : `/${prefix}/${slug}`;
    case 'regrade_request':
      return `/${prefix}/${slug}/regrade-requests`;
    default:
      return `/${prefix}/${slug}`;
  }
};
