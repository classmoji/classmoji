import { ClassmojiService, getAuthSession } from '~/utils/db.server.js';

/**
 * GET /api/pages/:classroomSlug
 * Returns list of pages for the classroom, filtered by user role
 */
export const loader = async ({ params, request }) => {
  const { classroomSlug } = params;

  // Fetch classroom
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  if (!classroom) {
    return Response.json({ error: 'Classroom not found' }, { status: 404 });
  }

  // Get auth (optional for public access)
  let authData = null;
  try {
    authData = await getAuthSession(request);
  } catch {
    // Not authenticated - will show public pages only
  }

  let pages = [];

  if (authData) {
    // Get membership
    const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.id,
      authData.userId
    );

    if (membership) {
      const role = membership.role;

      if (role === 'OWNER' || role === 'TEACHER') {
        // Admins see all pages including drafts
        pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
          includeClassroom: false,
        });
      } else {
        // Students/assistants see published pages only
        const allPages = await ClassmojiService.page.findByClassroomId(classroom.id, {
          includeClassroom: false,
        });
        pages = allPages.filter(p => !p.is_draft);
      }
    }
  }

  if (pages.length === 0) {
    // Public users see public non-draft pages
    const allPages = await ClassmojiService.page.findByClassroomId(classroom.id, {
      includeClassroom: false,
    });
    pages = allPages.filter(p => p.is_public && !p.is_draft);
  }

  return Response.json({
    pages: pages.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      is_draft: p.is_draft,
      is_public: p.is_public,
    })),
  });
};
