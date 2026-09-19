import {
  assertClassroomMutationAllowed,
  assertProTier,
  requireClassroomStaff,
  type ClassroomStatusInput,
} from '@classmoji/auth/server';

/**
 * The forms subtree's gate.
 *
 * Composes the audited platform guards rather than cloning them: staff access
 * comes from `requireClassroomStaff` (OWNER | TEACHER, denials auto-logged,
 * classroom-status entry rule applied), the Pro decision from the lifted
 * `assertProTier`. Nothing here re-implements a role check.
 *
 * WHY EVERY LOADER *AND* ACTION MUST CALL IT: `root.tsx` exempts the public
 * fill paths from the login redirect, and an exemption that recognizes shapes
 * cannot also be a second wall behind the routes it exempts. For the forms
 * subtree the route-level gate is the wall. A loader-only gate would leave the
 * status select, the delete button, and the builder's save as unauthenticated
 * POST endpoints — the classic "the list is protected so the mutations must be"
 * mistake.
 */

/** The forms vocabulary in audit rows, shared with the webapp redirect route. */
const FORMS_RESOURCE = 'FORMS';

/**
 * Redirect a session-less caller to the webapp login, the way `root.tsx` does,
 * instead of letting the platform guard's bare 401 surface.
 *
 * Both are safe — neither serves any data — but they are not equally useful. On
 * a document request the root loader and this one race, and which of a redirect
 * and a 401 the client ends up seeing is a framework detail. Answering with the
 * same redirect from both makes an anonymous GET of an admin forms path land on
 * the login page deterministically, which is what the gate spec asserts.
 */
const loginRedirect = (request: Request): Response => {
  const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
  const target = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: { Location: `${webappUrl}?redirect=${encodeURIComponent(target.href)}` },
  });
};

export interface FormAdminContext {
  userId: string;
  classroom: { id: string; slug: string; name?: string | null; status?: string };
  membership: { role: string };
}

/**
 * Assert the caller may manage forms in this classroom: signed in, OWNER or
 * TEACHER, and the classroom is on Pro.
 *
 * Order matters. Access first, Pro second: a stranger probing `/{slug}/forms`
 * must not learn a classroom's billing tier, and running the subscription
 * lookup before the membership check would answer differently for a Pro
 * classroom than for a free one.
 *
 * @throws Response 302 (no session), 403 (not staff, or not Pro), 404 (no such
 *   classroom) — thrown, so route loaders let them propagate.
 */
export async function assertFormAdmin(
  classroomSlug: string,
  request: Request,
  options: { action?: string } = {}
): Promise<FormAdminContext> {
  let access;
  try {
    access = await requireClassroomStaff(request, classroomSlug, {
      resourceType: FORMS_RESOURCE,
      action: options.action ?? 'access',
    });
  } catch (thrown) {
    if (thrown instanceof Response && thrown.status === 401) throw loginRedirect(request);
    throw thrown;
  }

  await assertProTier(classroomSlug);

  return access as unknown as FormAdminContext;
}

/**
 * Classroom-status mutation gate (SEC4), applied to forms for the same reason
 * `pageMutationBlocked` applies it to pages: a LOCKED or UNPUBLISHED classroom
 * is read-only for everyone but its owner, and a form definition is classroom
 * content like any other.
 *
 * Returns the platform's typed 403 Response for the action to RETURN as data
 * rather than throw — a thrown Response from a fetcher submit escalates to the
 * route ErrorBoundary and unmounts the builder mid-edit.
 */
export function formMutationBlocked(classroom: { status?: string }, role: string): Response | null {
  try {
    assertClassroomMutationAllowed({
      status: classroom.status as ClassroomStatusInput['status'],
      role: role as ClassroomStatusInput['role'],
    });
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}
