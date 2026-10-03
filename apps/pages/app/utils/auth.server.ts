import { assertClassroomMutationAllowed, type ClassroomStatusInput } from '@classmoji/auth/server';
import { getAuthSession } from '~/utils/db.server.ts';
import { findClassroomRole } from '~/utils/classroomRole.server.ts';
import type { PageForContent } from '~/types/pages.ts';

/**
 * Classroom-status mutation gate (SEC4) — the platform-wide rule from
 * `@classmoji/auth`: owners may always mutate; non-owners only while the
 * classroom is ACTIVE (LOCKED and UNPUBLISHED are read-only).
 *
 * Returns the platform's typed 403 Response (JSON body
 * `{ error: 'CLASSROOM_LOCKED' | 'CLASSROOM_UNPUBLISHED', message }`) for the
 * action to RETURN as data, or null when mutation is allowed. Returning (not
 * throwing) matters here: a thrown Response from a fetcher-submitted action
 * escalates to the route ErrorBoundary and unmounts the editor.
 */
export function pageMutationBlocked(
  classroom: { status: ClassroomStatusInput['status'] },
  role: string
): Response | null {
  try {
    assertClassroomMutationAllowed({
      status: classroom.status,
      role: role as ClassroomStatusInput['role'],
    });
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

interface AssertPageAccessOptions {
  request: Request;
  page: PageForContent;
  accessType?: 'view' | 'edit';
  /**
   * Count only a membership whose invite was accepted, as the class site does
   * (`resolveViewer`): an invited-but-never-joined user is not a member there,
   * and must not be one here either. Off by default for the callers that
   * predate it.
   */
  acceptedOnly?: boolean;
}

interface PageAccessResult {
  canView: boolean;
  canEdit: boolean;
  membership: { role: string } | null;
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
export async function assertPageAccess({
  request,
  page,
  accessType = 'view',
  acceptedOnly = false,
}: AssertPageAccessOptions): Promise<PageAccessResult> {
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

    // Their role in this classroom: the highest of the rows they hold there.
    const role = await findClassroomRole({
      userId: authData.userId,
      classroomId: page.classroom_id,
      acceptedOnly,
    });

    result.membership = role ? { role } : null;

    if (role) {
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
