import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { READER_API_JSON_HEADERS, isForeignFetch } from '~/utils/pageSections.server.ts';
import { activeSiteFor, siteSubdomainOf } from './apiBinding.server.ts';
import { buildSitePayload, readSitePageContent, type SitePageRow } from './pageRender.server.ts';
import { resolveSiteViewer } from './tenant.server.ts';

/**
 * `GET /api/page-reader?pageId=` — a class-site MEMBER's reader payload for
 * one page, for the session's viewer: what the island loads again after an
 * unlock (`reader-island/hostOptions.ts`), built by the SAME function and the
 * SAME site rules as the page itself (`buildSitePayload`).
 *
 * Only on a class-site subdomain, where the host middleware passes the path
 * through and stamps the subdomain (`siteSubdomainOf`); on the pages host, or
 * anywhere without that stamp, it does not exist (404). The same 404, with no
 * body worth reading, for everything else that is not "an accepted member of
 * this site's classroom reading a page this site serves them": no session, a
 * non-member (pending invites included), a site that is not active, an
 * unknown page, a page of another classroom, a draft.
 *
 * A request another site set off (`Sec-Fetch-Site` present and not
 * `same-origin`) is the same 404.
 *
 * `private, no-store` and `nosniff`. Under "View as" this is a platform admin
 * reading another user's state on a page, so it writes a VIEW audit row
 * (`data.tool: 'page_reader'`, `via: 'site'`, `impersonated_by`); a member
 * reading their own state is not logged.
 */

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { ...READER_API_JSON_HEADERS } });

const notFound = () => json({ error: 'Not found' }, 404);

const ROW_ID = /^[A-Za-z0-9_-]{1,255}$/;

export async function sitePageReaderResponse({
  request,
  context,
}: {
  request: Request;
  context?: unknown;
}): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed' }, 405);
    }
    const subdomain = siteSubdomainOf(context);
    if (!subdomain) return notFound();
    // An audited read (under "View as"): this origin's own pages only.
    if (isForeignFetch(request)) return notFound();

    const pageId = new URL(request.url).searchParams.get('pageId');
    if (!pageId || !ROW_ID.test(pageId)) return notFound();

    const site = await activeSiteFor(subdomain);
    if (!site) return notFound();

    // The site's own viewer: accepted memberships in the SITE's classroom only.
    const viewer = await resolveSiteViewer(request, site.classroom_id);
    if (!viewer.userId || viewer.role === null) return notFound();

    // Scoped to the site's classroom in the query: an id from anywhere else finds nothing.
    const page = (await prisma.page.findFirst({
      where: { id: pageId, classroom_id: site.classroom_id },
    })) as SitePageRow | null;
    if (!page || page.classroom_id !== site.classroom_id) return notFound();
    if (!ClassmojiService.site.isPageVisibleOnSite(page, viewer.role)) return notFound();

    let content;
    try {
      content = await readSitePageContent(request, page, site.classroom);
    } catch (error) {
      if (error instanceof Response) return json({ error: 'Unavailable' }, 503);
      throw error;
    }

    const payload = await buildSitePayload({
      site,
      viewer,
      page,
      content,
      // A member has no sign-in link; the builder asks only for a non-member.
      signInUrl: '',
    });

    if (viewer.impersonated && request.method !== 'HEAD') {
      // The read is the viewer's either way: a failed log line is reported
      // (`audit_miss`) and does not fail it.
      await ClassmojiService.audit.record({
        user_id: viewer.userId,
        classroom_id: site.classroom_id,
        role: viewer.role,
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'VIEW',
        data: {
          tool: 'page_reader',
          via: 'site',
          page_id: page.id,
          ...(viewer.impersonatedBy ? { impersonated_by: viewer.impersonatedBy } : {}),
        },
      });
    }

    return json({ payload });
  } catch (error) {
    console.error('[page-reader] failed:', error);
    return json({ error: 'Something went wrong' }, 500);
  }
}
