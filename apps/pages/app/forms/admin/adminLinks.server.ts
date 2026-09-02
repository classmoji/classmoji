import { ClassmojiService } from '~/utils/db.server.ts';
// The app's one place for these reads. `app/site/env.server.ts` was written for
// the class-site routes, but `webappUrl` is the same answer the forms admin
// needs, complete with its dev fallbacks — a second copy here would be a second
// set of defaults to keep in step.
import { webappUrl } from '~/site/env.server.ts';
import { canonicalOriginForSite, rolePrefix } from '~/site/tenant.server.ts';

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
 * The public URL a form should be shared as — the origin AND the path, from one
 * place.
 *
 * ONE function for both halves, deliberately, because splitting them is what
 * broke this. An earlier `publicFormOrigin` answered only "which hostname", and
 * each caller appended the pages-shaped `/{classroomSlug}/forms/{formSlug}` to
 * whatever came back. On a class-site host that path does not exist: the site
 * tree serves the SHORT bridge path `/forms/{formSlug}` and nothing else (see
 * `app/site/forms.ts`), so every link copied for a classroom with a site was a
 * 404. The two decisions are one decision, and they now have one home.
 *
 * ── Which hostname ─────────────────────────────────────────────────────────
 * The SHORT class-site link when the classroom has a site — `cs52.classmoji.io`,
 * or `cs52.dartmouth.edu` once the instructor connects their own domain —
 * because that is the address of the course, and a link that fits on a slide is
 * the whole point of the bridge in `app/site/forms.ts`. Every one of those
 * hostnames serves the same form; the site ones just 302 across.
 *
 * WHICH of them is the site's own rule, not a second one written here:
 * `canonicalOriginForSite` is what the site itself puts in `rel=canonical`, and
 * a form shared on a course should be shared on the address that course claims.
 * The deliberate consequence is the lapsed case. When PRO lapses the custom
 * domain stops being canonical and the copied link goes back to the subdomain —
 * a longer URL, but the custom host is 302ing visitors to that subdomain
 * anyway, and a link that keeps working beats a link that is shorter.
 *
 * Falls back to the origin that served THIS request (not `pagesUrl()`): that is
 * what the list has always copied, and it is what keeps the link right on a
 * devport, in a tunnel, and anywhere else the configured URL is not the one the
 * instructor is actually looking at.
 *
 * The canonical origin is null when SITE_BASE_DOMAIN is unset, so an
 * environment with the site feature off keeps the canonical link with no branch
 * of its own.
 *
 * ── Why it returns a builder ───────────────────────────────────────────────
 * The list renders every form in the classroom, and the hostname is a property
 * of the CLASSROOM, not of the form: resolving it per row would run the site
 * read and the subscription read once per form. One await, then a pure function
 * the caller maps over its rows — and because the caller is handed a finished
 * URL rather than a base to append to, there is no seam left for a path shape
 * to disagree across again.
 */
export async function publicFormUrlFor(
  classroom: { id: string; status?: string; is_archived?: boolean },
  requestOrigin: string,
  classroomSlug: string
): Promise<(formSlug: string) => string> {
  const origin = await servingSiteOrigin(classroom);
  // The site bridge's own shape, and the only forms path a site host serves.
  if (origin) return formSlug => `${origin}/forms/${formSlug}`;
  // The canonical pages route, which is where the bridge redirects to anyway.
  return formSlug => `${requestOrigin}/${classroomSlug}/forms/${formSlug}`;
}

/**
 * The class site's canonical origin, or null when no site serves this
 * classroom's forms.
 *
 * The three conditions under which the site does not serve mirror
 * `getSiteBySubdomain` — which is what the bridge resolves through, so a short
 * link built past any of them would 404 while the canonical one works. A link
 * that works beats a link that is shorter.
 *
 * BOTH classroom conditions, not just the status one: `is_archived` is a
 * separate boolean from ClassroomStatus, and the staff gate does not consider
 * it, so staff of an archived classroom do reach this screen.
 */
async function servingSiteOrigin(classroom: {
  id: string;
  status?: string;
  is_archived?: boolean;
}): Promise<string | null> {
  if (classroom.is_archived || classroom.status === 'UNPUBLISHED') return null;

  const site = await ClassmojiService.site.getSiteForClassroom(classroom.id);
  if (!site || !site.is_enabled) return null;
  return await canonicalOriginForSite(site);
}
