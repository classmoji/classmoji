import type { LoaderFunctionArgs } from 'react-router';

import { siteHeaders } from './headers.server.ts';
import { hasPublicPages, loadSitePageIndex, resolveSiteContext } from './tenant.server.ts';

/**
 * `robots.txt` for a class website.
 *
 * The interesting case is a site with no public pages at all — an enabled site
 * whose every page is members-only. Crawlers would find nothing but sign-in
 * interstitials, and indexing those would put the course's name in search
 * results attached to a permanently empty page. So: no public pages,
 * `Disallow: /`.
 *
 * No `Sitemap:` line in v1. A sitemap would have to enumerate public pages,
 * and getting that wrong leaks titles; it is a deliberate follow-up, not an
 * oversight.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const { site } = await resolveSiteContext(args);
  const pages = await loadSitePageIndex(args, site.classroom_id);
  const indexable = hasPublicPages(pages);

  const body = indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n';

  return new Response(body, {
    status: 200,
    headers: siteHeaders({
      request,
      cacheable: indexable,
      noindex: !indexable,
      contentType: 'text/plain; charset=utf-8',
    }),
  });
};
