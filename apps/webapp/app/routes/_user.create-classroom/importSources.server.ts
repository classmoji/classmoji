import getPrisma from '@classmoji/database';
import { SOURCE_ROLES } from './sourceAccess';

/**
 * The classrooms this user may import FROM: ones they own or teach (a teacher
 * may copy a class they teach, minus the API keys; see importFlow.server.ts),
 * on either provider, with the counts the import step shows. `is_owner`
 * replaces the viewer's membership rows, which are dropped.
 */
export async function loadImportableClassrooms(userId: string) {
  const user = { id: userId };
  const classrooms = await getPrisma().classroom.findMany({
    where: {
      memberships: {
        some: {
          user_id: user.id,
          // Shared with the action's re-verification. If these two ever drift,
          // the picker offers a source the action refuses — a dead end reached
          // only after the whole wizard has been filled in.
          role: { in: [...SOURCE_ROLES] },
        },
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      // THIS viewer's roles only, and only the role column — enough to derive
      // `is_owner` below. A wider select would serialize every member's
      // membership rows into the picker payload.
      memberships: {
        where: { user_id: user.id },
        select: { role: true },
      },
      git_organization: {
        select: {
          login: true,
        },
      },
      // Counts drive the "Also copy" checkboxes on the import step.
      _count: {
        select: {
          pages: true,
          slides: true,
          modules: true,
          calendar_events: true,
          emoji_mappings: true,
          letter_grade_mappings: true,
        },
      },
      repositories: {
        select: {
          id: true,
          title: true,
          template: true,
          type: true,
          _count: {
            select: {
              assignments: true,
              quizzes: true,
            },
          },
        },
        orderBy: { title: 'asc' },
      },
    },
    orderBy: { created_at: 'desc' },
  });
  return classrooms.map(({ memberships, ...classroom }) => ({
    ...classroom,
    is_owner: memberships.some(m => m.role === 'OWNER'),
  }));
}
