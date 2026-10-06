import { redirect } from 'react-router';
import { getAuthSession, resolveHighestMembership } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { STAFF_ROLES, staffRedirectPath, staffRoleForStudentRoute } from './studentRouteRedirect';

/**
 * Turn a student-gate refusal into a redirect for staff (#403).
 *
 * Call it ONLY from the catch of `requireStudentAccess`, with what that threw.
 * It returns a redirect when the caller is a signed-in OWNER/TEACHER/ASSISTANT
 * of this classroom without a STUDENT membership, and null otherwise — the
 * caller then rethrows the original refusal untouched, so a non-member, a
 * member of another classroom, a signed-out visitor or a refused student sees
 * exactly what they saw before, and nothing about the classroom leaks.
 *
 * It changes no access decision: the refusal has already happened (and been
 * audit-logged by assertClassroomAccess) before this runs, and the target is a
 * path in the caller's own section, whose routes gate themselves. Membership is
 * resolved with the same `resolveHighestMembership` the gates use, so the
 * section chosen is the one those gates will admit.
 */
export async function staffRedirectFromStudentRoute(
  request: Request,
  classSlug: string,
  denial: unknown
): Promise<Response | null> {
  if (!(denial instanceof Response) || denial.status !== 403) return null;

  const session = await getAuthSession(request);
  if (!session) return null;

  const classroom = await ClassmojiService.classroom.findBySlug(classSlug);
  if (!classroom) return null;

  const [staff, student] = await Promise.all([
    resolveHighestMembership(classroom.id, session.userId, [...STAFF_ROLES]),
    resolveHighestMembership(classroom.id, session.userId, ['STUDENT']),
  ]);
  const role = staffRoleForStudentRoute(
    [staff?.role, student?.role].filter((r): r is NonNullable<typeof r> => Boolean(r))
  );
  if (!role) return null;

  const url = new URL(request.url);
  return redirect(
    staffRedirectPath({
      role,
      classSlug: classroom.slug,
      pathname: url.pathname,
      search: url.search,
    })
  );
}
