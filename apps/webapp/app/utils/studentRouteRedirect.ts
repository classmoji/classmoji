/**
 * Where a staff member who opens a /student/:class/... URL is sent instead
 * (#403).
 *
 * /student/:class/** is STUDENT-only (its layout loader calls
 * requireStudentAccess), so an owner, teacher or assistant who follows a
 * student link — a shared URL, a bookmark, a link copied from a student —
 * used to get a bare 403. They are now redirected to the same screen in their
 * own section when that section has one, and otherwise to their section's
 * dashboard for the classroom.
 *
 * This file is only the DECISION, and it grants nothing: the target is a path
 * in the caller's own section, whose routes run their own gates. Pure, so it
 * can be tested without a request or a database; the lookup that feeds it is
 * `studentRouteRedirect.server.ts`.
 */
import { roleSettings } from '~/constants/roleSettings';

export type StaffRole = 'OWNER' | 'TEACHER' | 'ASSISTANT';

/** Most privileged first: a multi-role staff member lands in their highest section. */
export const STAFF_ROLES: readonly StaffRole[] = ['OWNER', 'TEACHER', 'ASSISTANT'];

/** Every section's classroom landing page (the /teacher and /assistant index routes redirect here too). */
export const STAFF_HOME = 'dashboard';

/**
 * Student subpath (after /student/:class/) → the same screen's subpath in each
 * staff section. A role missing from an entry has no twin and goes to
 * STAFF_HOME; so does any subpath not listed here, including every dynamic
 * one (pages/:pageId, quizzes/:quizId/attempt/:attemptId, repos/:repo/team,
 * regrade-requests/new) — a student's record or form is not a staff screen.
 *
 * Every target is pinned to an existing route module by
 * utils/__tests__/studentRouteRedirect.test.ts, and every static student
 * screen must be listed here (with `{}` when it has no twin), so a renamed or
 * new route fails that test instead of silently redirecting somewhere wrong.
 */
export const STAFF_TWINS: Readonly<Record<string, Partial<Record<StaffRole, string>>>> = {
  dashboard: { OWNER: 'dashboard', TEACHER: 'dashboard', ASSISTANT: 'dashboard' },
  calendar: { OWNER: 'calendar', TEACHER: 'calendar', ASSISTANT: 'calendar' },
  modules: { OWNER: 'modules', TEACHER: 'modules', ASSISTANT: 'modules' },
  pages: { OWNER: 'pages', TEACHER: 'pages', ASSISTANT: 'pages' },
  slides: { OWNER: 'slides', TEACHER: 'slides', ASSISTANT: 'slides' },
  quizzes: { OWNER: 'quizzes', TEACHER: 'quizzes', ASSISTANT: 'quizzes' },
  'regrade-requests': {
    OWNER: 'regrade-requests',
    TEACHER: 'regrade-requests',
    ASSISTANT: 'regrade-requests',
  },
  repos: { OWNER: 'repos', TEACHER: 'repos', ASSISTANT: 'repos' },
  // Only the owner section has an assignments list or a token ledger.
  assignments: { OWNER: 'assignments' },
  tokens: { OWNER: 'tokens' },
  // Member settings, which itself redirects everyone to /settings/appearance,
  // and that redirect wins over this map's, so every role ends up there.
  // /teacher and /assistant re-export it; /admin/:class/settings is the
  // CLASSROOM's settings, a different screen, so no OWNER twin.
  settings: { TEACHER: 'settings', ASSISTANT: 'settings' },
};

/**
 * The section a caller holding `roles` in a classroom is redirected to, or
 * null for no redirect. Anyone holding STUDENT is admitted by the student
 * gate, so they are never redirected (if that gate refused them anyway — an
 * unpublished classroom — its own refusal is the right answer); otherwise the
 * highest staff role decides.
 */
export function staffRoleForStudentRoute(roles: readonly string[]): StaffRole | null {
  if (roles.includes('STUDENT')) return null;
  return STAFF_ROLES.find(role => roles.includes(role)) ?? null;
}

/**
 * The same-origin path to send `role` to from the student URL `pathname`.
 *
 * Built only from constants and the classroom slug: the student subpath is
 * used as a lookup KEY, never copied into the result, so no request input can
 * steer the redirect off-site or into another section. The query string is
 * kept only when landing on the same screen (where it may still mean
 * something); `search` is URL.search, so it is empty or starts with "?" and
 * cannot change the path or origin.
 */
export function staffRedirectPath({
  role,
  classSlug,
  pathname,
  search = '',
}: {
  role: StaffRole;
  classSlug: string;
  pathname: string;
  search?: string;
}): string {
  const base = `${roleSettings[role].path}/${encodeURIComponent(classSlug)}/`;

  const segments = pathname.split('/').filter(Boolean);
  const subpath =
    segments[0]?.toLowerCase() === 'student' ? segments.slice(2).join('/').toLowerCase() : '';

  const twin = Object.hasOwn(STAFF_TWINS, subpath) ? STAFF_TWINS[subpath][role] : undefined;
  if (!twin) return base + STAFF_HOME;

  const query = search.startsWith('?') && search.length > 1 ? search : '';
  return base + twin + query;
}
