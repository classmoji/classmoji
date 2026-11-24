import type { RouterContextProvider } from 'react-router';

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { highestRole } from '~/utils/classroomRole.ts';
import type { SiteApiBinding } from '~/utils/pageSections.server.ts';
import { siteLoadContext } from '../../server/loadContext.ts';

/**
 * The reader API on a class-site host.
 *
 * The host middleware passes exactly three API paths through on a class-site
 * SUBDOMAIN (`SITE_API_PATHS` in server/siteHost.ts) and stamps the request
 * with the subdomain it resolved; it reaches the route as
 * `siteLoadContext.siteSubdomain`. Nothing the client sends can set it.
 *
 * The stamp is not authorization. A handler that finds it binds the call to
 * that site (`siteApiBinding`), re-reading the site from the database.
 */

/** The class-site subdomain this API call arrived on, or null (the pages host, or no context). */
export function siteSubdomainOf(context: unknown): string | null {
  const provider = context as { get?: unknown } | null | undefined;
  if (typeof provider?.get !== 'function') return null;
  const value = (provider as Pick<RouterContextProvider, 'get'>).get(siteLoadContext).siteSubdomain;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The site this subdomain serves, when it is servable (`active`), else null. */
export async function activeSiteFor(subdomain: string) {
  const lookup = await ClassmojiService.site.getSiteBySubdomain(subdomain);
  return lookup.state === 'active' ? lookup.site : null;
}

/** The user's highest ACCEPTED role in a classroom (the site's membership rule), or null. */
export async function acceptedRoleIn(classroomId: string, userId: string) {
  const rows = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: userId, has_accepted_invite: true },
    select: { role: true },
  });
  return highestRole(rows.map(row => row.role));
}

/**
 * The reader rule on a class-site host, from ACCEPTED memberships only — the
 * rule the site's payload uses (`siteReaderViewer`). The pages host keeps the
 * app's rule (any invite state); here a pending staff invite reveals nothing.
 */
export async function siteSectionViewer({
  userId,
  classroomId,
}: {
  userId: string;
  classroomId: string;
}) {
  const rows = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: userId, has_accepted_invite: true },
    select: { role: true },
  });
  return ClassmojiService.pageSections.sectionViewerFromMemberships(
    rows.map(row => ({ role: row.role, has_accepted_invite: true }))
  );
}

/**
 * The binding for a call that arrived on a class-site subdomain, or null on
 * any other host. `allows` is true only when the site is active, the page
 * belongs to the site's classroom, it is not a draft, the user is an ACCEPTED
 * member there (the only people the site gives these features) and the page
 * is visible on the site to them.
 */
export function siteApiBinding(context: unknown): SiteApiBinding | null {
  const subdomain = siteSubdomainOf(context);
  if (!subdomain) return null;
  return {
    async allows({ page, userId }) {
      const site = await activeSiteFor(subdomain);
      if (!site) return false;
      if (page.classroom_id !== site.classroom_id || page.is_draft) return false;
      const role = await acceptedRoleIn(site.classroom_id, userId);
      if (role === null) return false;
      return ClassmojiService.site.isPageVisibleOnSite(
        { is_draft: page.is_draft, is_public: page.is_public === true },
        role
      );
    },
  };
}
