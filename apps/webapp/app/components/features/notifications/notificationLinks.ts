import type { BellNotification, NotificationRole } from './NotificationBell';

type Role = NotificationRole;

const STUDENT_NOTIFICATION_TYPES = new Set([
  'QUIZ_PUBLISHED',
  'PAGE_PUBLISHED',
  'PAGE_UNPUBLISHED',
  'MODULE_PUBLISHED',
  'MODULE_UNPUBLISHED',
  'ASSIGNMENT_DUE_DATE_CHANGED',
  'ASSIGNMENT_GRADED',
]);

const ASSISTANT_NOTIFICATION_TYPES = new Set(['TA_GRADING_ASSIGNED', 'TA_REGRADE_ASSIGNED']);

const rolePrefix = (role: Role): string => {
  if (role === 'STUDENT') return 'student';
  if (role === 'ASSISTANT') return 'assistant';
  return 'admin';
};

const roleForNotification = (type: string, roles: Role[]): Role | null => {
  if (roles.length === 0) return null;
  if (STUDENT_NOTIFICATION_TYPES.has(type) && roles.includes('STUDENT')) return 'STUDENT';
  if (ASSISTANT_NOTIFICATION_TYPES.has(type) && roles.includes('ASSISTANT')) return 'ASSISTANT';
  return roles.find(role => role === 'OWNER' || role === 'TEACHER') ?? roles[0] ?? null;
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
      // Only the admin route tree has a quiz detail page; students/assistants land on the list.
      return prefix === 'admin'
        ? `/${prefix}/${slug}/quizzes/${n.resource_id}`
        : `/${prefix}/${slug}/quizzes`;
    case 'assignment':
      // Only the student route tree has an assignments list page.
      return prefix === 'student' ? `/${prefix}/${slug}/assignments` : `/${prefix}/${slug}`;
    case 'module':
      return `/${prefix}/${slug}/modules`;
    case 'page':
      return `/${prefix}/${slug}/pages/${n.resource_id}`;
    case 'repository_assignment':
      // TA grading queue only exists under the assistant route tree.
      return prefix === 'assistant' ? `/${prefix}/${slug}/grading` : `/${prefix}/${slug}`;
    case 'regrade_request':
      return `/${prefix}/${slug}/regrade-requests`;
    default:
      return `/${prefix}/${slug}`;
  }
};
