/**
 * Links from the slides app back into the webapp.
 *
 * The webapp keeps one route tree per role, and each tree is gated to that
 * role: `/admin/...` is OWNER-only, `/teacher/...` is the TEACHER copy,
 * `/assistant/...` the assistant copy. Slides pages are reachable by the whole
 * teaching team, so a hardcoded `/admin/...` back-link works for the owner and
 * sends everyone else to a page they cannot open.
 *
 * These links are built from the role the SERVER resolved for the request
 * (`assertSlideAccess` / `assertClassroomAccess` return the membership at the
 * caller's highest role) rather than from the client's membership list, so a
 * teaching-team member who is also enrolled as a student still lands on the
 * staff copy.
 *
 * This is a link target only — it decides which URL to point at, never who may
 * open it. Every one of these routes runs its own authorization check.
 */

/** The webapp route prefix a role's own copy of a classroom page lives under. */
export function webappRolePrefix(role: string | null | undefined): string {
  if (role === 'OWNER') return 'admin';
  if (role === 'TEACHER') return 'teacher';
  if (role === 'ASSISTANT') return 'assistant';
  // Unknown or STUDENT: the student tree is the only one that is safe to guess
  // at. Guessing `admin` would point at the owner-gated tree — the very thing
  // this helper exists to avoid.
  return 'student';
}

/**
 * A path into the webapp for a classroom section, in the acting role's tree.
 *
 * @example webappClassPath('TEACHER', 'cs52', 'slides') // '/teacher/cs52/slides'
 */
export function webappClassPath(
  role: string | null | undefined,
  classroomSlug: string,
  section: string
): string {
  return `/${webappRolePrefix(role)}/${classroomSlug}/${section}`;
}

/** The same path as an absolute URL, for links that leave this host. */
export function webappClassUrl(
  webappUrl: string,
  role: string | null | undefined,
  classroomSlug: string,
  section: string
): string {
  return `${webappUrl}${webappClassPath(role, classroomSlug, section)}`;
}
