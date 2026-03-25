import { prisma, getAuthSession } from '~/utils/db.server.ts';

interface AssertPageAccessOptions {
  request: Request;
  page: any;
  accessType?: 'view' | 'edit';
}

interface PageAccessResult {
  canView: boolean;
  canEdit: boolean;
  membership: any;
  userId: string | null;
}

/**
 * Assert page access with visibility-tier checks.
 *
 * Visibility tiers:
 * - Draft pages: only OWNER/TEACHER can view/edit
 * - Private pages: classroom members can view, OWNER/TEACHER can edit
 * - Public pages: anyone can view, OWNER/TEACHER can edit
 */
export async function assertPageAccess({ request, page, accessType = 'view' }: AssertPageAccessOptions): Promise<PageAccessResult> {
  const result: PageAccessResult = {
    canView: false,
    canEdit: false,
    membership: null,
    userId: null,
  };

  // Try to get auth (may be null for public pages)
  let authData = null;
  try {
    authData = await getAuthSession(request);
  } catch {
    // Auth failed — only public pages accessible
  }

  if (authData) {
    result.userId = authData.userId;

    // Get membership in this classroom
    const membership = await prisma.classroomMembership.findFirst({
      where: {
        user_id: authData.userId,
        classroom_id: page.classroom_id,
      },
      include: { classroom: true },
    });

    result.membership = membership;

    if (membership) {
      const role = membership.role;
      const isStaff = role === 'OWNER' || role === 'TEACHER';
      const isTeachingTeam = isStaff || role === 'ASSISTANT';

      // Edit permissions: staff only
      result.canEdit = isStaff;

      // View permissions by page state
      if (page.is_draft) {
        // Drafts: only teaching team can view
        result.canView = isTeachingTeam;
      } else {
        // Published (private or public): any member can view
        result.canView = true;
      }
    }
  }

  // Public pages: anyone can view (even without auth)
  if (page.is_public && !page.is_draft) {
    result.canView = true;
  }

  // Enforce access
  if (accessType === 'edit' && !result.canEdit) {
    throw new Response('You do not have permission to edit this page', { status: 403 });
  }

  if (accessType === 'view' && !result.canView) {
    throw new Response('You do not have permission to view this page', { status: 403 });
  }

  return result;
}
