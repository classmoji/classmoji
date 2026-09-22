// The app's one place for these reads. `app/site/env.server.ts` was written for
// the class-site routes, but `webappUrl` is the same answer the forms admin
// needs, complete with its dev fallbacks — a second copy here would be a second
// set of defaults to keep in step.
import { webappUrl } from '~/site/env.server.ts';
import { rolePrefix } from '~/site/tenant.server.ts';

/**
 * The two links the forms admin screens need that point OUTSIDE the pages app.
 *
 * Both are computed on the server because both depend on things the browser
 * cannot see: which webapp origin this deployment talks to, and whether the
 * classroom has a course site at all.
 */

/**
 * The public URL a form is shared as, re-exported from `@classmoji/services`.
 *
 * It moved into the shared package when the webapp grew a forms list of its
 * own: the link staff copy must be the SAME link from either list, and the
 * webapp cannot import from this app. Re-exported here under the name the
 * builder and the list already import, so neither changed.
 */
export { publicFormUrlFor } from '@classmoji/services';

/**
 * Where "back" goes from a forms screen: the classroom's FORMS list in the
 * webapp, for the role that got through `assertFormAdmin`.
 *
 * The forms list now lives in the webapp (`admin.$class.forms`, and the
 * `/teacher` twin), and that is where staff arrive from — the nav entry no
 * longer redirects across. Landing them back on the dashboard, which is where
 * this pointed while the webapp had no list of its own, would drop them a level
 * above the screen they came from.
 *
 * The role prefix matters. `/admin/:class/**` carries an owner-only loader, so
 * sending a TEACHER there would bounce them off a screen they are entitled to —
 * they belong under `/teacher`. `rolePrefix` is the site bridge's answer to the
 * same question and is reused rather than restated; forms admin is OWNER or
 * TEACHER today (`requireClassroomStaff`), and the other branches cost nothing
 * and stop being wrong the day that widens.
 *
 * ASSISTANT and STUDENT have no forms route to land on, so for them — and for a
 * role the prefix map does not know — this falls back to the app's front door,
 * which resolves the classroom for whoever arrives. Neither can reach a forms
 * screen today; the branch exists so that widening the gate cannot silently
 * produce a dead link.
 */
export function formsListUrl(role: string, classroomSlug: string): string {
  const prefix = rolePrefix(role as Parameters<typeof rolePrefix>[0]);
  if (prefix !== 'admin' && prefix !== 'teacher') return `${webappUrl()}/`;
  return `${webappUrl()}/${prefix}/${classroomSlug}/forms`;
}
