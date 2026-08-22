/**
 * The page data the compressed student/assistant IA needs, in one read.
 *
 * Since the sidebar stopped hanging one entry per page (Option C), the only
 * page facts the shell needs are:
 *  - is there anything to show at all (else the single Pages entry hides, the
 *    same way Modules hides on a class with no modules); and
 *  - which pages have a public URL on the class site, so the peek drawer's
 *    "open in new tab" arrow can point at the site rather than back into the app.
 *
 * The site-visible map is deliberately NARROW: only non-draft, `is_public`
 * pages of an ENABLED site get an entry. Everything absent from it falls back
 * to the in-app full view, which is exactly the members-only behaviour the
 * drawer wants — no per-page fetch, no leaking of which drafts exist.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
// The one place a ClassroomSite row becomes a browser-facing origin
// (dev http://{sub}.{base}:{port}, prod https://{sub}.{base}). Imported rather
// than re-derived so SITE_BASE_DOMAIN/PAGES_URL are read in a single place.
import { resolveSiteOrigin } from '~/routes/site-return/siteReturn';

export interface PagesNavData {
  /** Does the class have any page a member could read? Drives nav visibility. */
  hasPages: boolean;
  /** Absolute origin of the class site, or null when there is no live site. */
  siteOrigin: string | null;
  /** pageId → site slug, for pages that are actually reachable on the site. */
  siteSlugByPageId: Record<string, string>;
  /**
   * The nominated front page, whether or not the site is switched on: choosing
   * a home page and publishing to the web are separate decisions, and the
   * docked Pages view keys off the former.
   */
  homePageId: string | null;
}

export const EMPTY_PAGES_NAV: PagesNavData = {
  hasPages: false,
  siteOrigin: null,
  siteSlugByPageId: {},
  homePageId: null,
};

/**
 * Read the site row + published pages for a classroom.
 *
 * Cheap by construction: three columns over one indexed classroom_id, plus a
 * single-row site lookup. Runs in the student/assistant layout loaders, so it
 * must stay that way.
 */
export async function loadPagesNav(classroomId: string): Promise<PagesNavData> {
  const [pages, site] = await Promise.all([
    getPrisma().page.findMany({
      where: { classroom_id: classroomId, is_draft: false },
      select: { id: true, slug: true, is_public: true },
    }),
    ClassmojiService.site.getSiteForClassroom(classroomId),
  ]);

  // A disabled site has no browser-facing URL at all — not "a URL that 404s".
  // resolveSiteOrigin also returns null when SITE_BASE_DOMAIN is unset, which
  // is how the whole class-sites feature stays inert before launch.
  const siteOrigin =
    site && site.is_enabled ? resolveSiteOrigin(site.subdomain, process.env) : null;

  const siteSlugByPageId: Record<string, string> = {};
  if (siteOrigin) {
    for (const page of pages) {
      if (page.is_public && page.slug) siteSlugByPageId[page.id] = page.slug;
    }
  }

  return {
    hasPages: pages.length > 0,
    siteOrigin,
    siteSlugByPageId,
    homePageId: site?.home_page_id ?? null,
  };
}
