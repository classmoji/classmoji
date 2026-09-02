import { ClassmojiService } from '~/utils/db.server.ts';
// The app's one place for these reads. `app/site/env.server.ts` was written for
// the class-site routes, but `webappUrl` and `siteOrigin` are the same two
// answers the forms admin needs, complete with their dev fallbacks — a second
// copy here would be a second set of defaults to keep in step.
import { siteOrigin, webappUrl } from '~/site/env.server.ts';
import { rolePrefix } from '~/site/tenant.server.ts';

/**
 * The two links the forms admin screens need that point OUTSIDE the pages app.
 *
 * Both are computed on the server because both depend on things the browser
 * cannot see: which webapp origin this deployment talks to, and whether the
 * classroom has a course site at all.
 */

/**
 * Where "back to the classroom" goes, for the role that got through
 * `assertFormAdmin`.
 *
 * The role prefix matters. `/admin/:class/**` carries an owner-only loader, so
 * sending a TEACHER there would bounce them off a screen they are entitled to —
 * they belong under `/teacher`. `rolePrefix` is the site bridge's answer to the
 * same question and is reused rather than restated; forms admin is OWNER or
 * TEACHER today (`requireClassroomStaff`), and the other branches cost nothing
 * and stop being wrong the day that widens.
 */
export function classroomHomeUrl(role: string, classroomSlug: string): string {
  const prefix = rolePrefix(role as Parameters<typeof rolePrefix>[0]);
  // A role the prefix map does not know is not a reason to render a dead link:
  // the app's front door resolves the classroom for whoever arrives.
  if (!prefix) return `${webappUrl()}/`;
  return `${webappUrl()}/${prefix}/${classroomSlug}/dashboard`;
}

/**
 * The origin a form's public link should be shared on.
 *
 * The SHORT class-site link when the classroom has a site — `cs52.classmoji.io`
 * — because that is the address of the course, and a link that fits on a slide
 * is the whole point of the bridge in `app/site/forms.ts`. Both hostnames serve
 * the same form; the site one just 302s across.
 *
 * Falls back to the origin that served THIS request (not `pagesUrl()`): that is
 * what the list has always copied, and it is what keeps the link right on a
 * devport, in a tunnel, and anywhere else the configured URL is not the one the
 * instructor is actually looking at.
 *
 * `siteOrigin` returns null when SITE_BASE_DOMAIN is unset, so an environment
 * with the site feature off keeps the canonical link with no branch of its own.
 */
export async function publicFormOrigin(
  classroomId: string,
  requestOrigin: string
): Promise<string> {
  const site = await ClassmojiService.site.getSiteForClassroom(classroomId);
  // A site switched off does not serve `/forms/…` either — the bridge resolves
  // through the same lookup — so a disabled site keeps the canonical link.
  if (!site || !site.is_enabled) return requestOrigin;
  return siteOrigin(site.subdomain) ?? requestOrigin;
}
