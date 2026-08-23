import { ClassmojiService } from '~/utils/db.server.ts';
import { loadSitePageContent, SiteContentUnavailableError } from './content.server.ts';
import { renderSitePage, siteArticleWrapper, SiteRenderError } from './render.server.ts';
import { siteHeaders } from './headers.server.ts';
import {
  loadSitePageIndex,
  sitePagePath,
  type SiteContext,
  type SiteLoaderArgs,
  type SitePageIndexEntry,
} from './tenant.server.ts';
import type { PageLinkResolver } from './viewerSchema.server.ts';

/**
 * The shared "render one page of this site" path.
 *
 * `/` (home) and `/{slug}` render identically — the home page IS a page, just
 * one the instructor nominated — so the composition lives here rather than
 * being written twice and drifting.
 */

/** The page row fields the site render needs. */
export type SitePageRow = {
  id: string;
  title: string | null;
  slug: string | null;
  content_path: string;
  is_public: boolean;
  is_draft: boolean;
  header_image_url?: string | null;
  header_image_position?: number | null;
  /** The editor's page-width setting (1-4). See `siteArticleWidthClass`. */
  width?: number | null;
};

export type RenderedSitePage = {
  title: string;
  html: string;
  coverImage: { url: string; position?: number } | null;
};

/**
 * Build the per-viewer page-id → link resolver from the request's page index.
 *
 * Invisible pages resolve to `null`, which every consuming block treats as
 * "drop this entry entirely" rather than "render it disabled" — an anonymous
 * visitor must not learn the titles of members-only pages by reading a nav
 * grid.
 */
export function createLinkResolver(
  pages: SitePageIndexEntry[],
  role: Parameters<typeof ClassmojiService.site.isPageVisibleOnSite>[1]
): PageLinkResolver {
  const byId = new Map<string, SitePageIndexEntry>();
  for (const page of pages) byId.set(page.id, page);

  return (pageId: string) => {
    const page = byId.get(pageId);
    if (!page) return null;
    // The index already excludes drafts; is_draft: false is restated so the
    // service's rule — not this call site's assumption — is what decides.
    if (
      !ClassmojiService.site.isPageVisibleOnSite(
        { is_draft: false, is_public: page.is_public },
        role
      )
    ) {
      return null;
    }
    // `membersOnly` is only ever computed for a viewer who has just passed the
    // visibility check above, so it cannot tell an anonymous visitor that a
    // page exists — it tells a MEMBER which links their signed-out classmates
    // would not be able to follow.
    return {
      href: sitePagePath(page),
      title: page.title || 'Untitled',
      membersOnly: !page.is_public,
    };
  };
}

// `siteArticleWidthClass` lives in render.server.ts, beside the wrapper it
// sizes — and out of reach of this module's database import, so the unit
// suite can exercise it without a Prisma client.
export { siteArticleWidthClass } from './render.server.ts';

/**
 * Load and render a page for the current viewer.
 *
 * Throws a 503 Response (never a cacheable empty 200) when the content repo
 * cannot be read or the document cannot be serialized — the two failures that
 * would otherwise publish a blank page over a real one and pin it in a shared
 * cache for a minute.
 */
export async function renderPageForViewer(
  args: SiteLoaderArgs,
  context: SiteContext,
  page: SitePageRow
): Promise<RenderedSitePage> {
  const { request } = args;
  const pages = await loadSitePageIndex(args, context.site.classroom_id);
  const resolveLink = createLinkResolver(pages, context.viewer.role);

  let content;
  try {
    content = await loadSitePageContent(page, context.site.classroom);
  } catch (error) {
    if (error instanceof SiteContentUnavailableError) {
      console.error('[site] content unavailable:', error.message, error.status);
      throw serviceUnavailable(request);
    }
    throw error;
  }

  let rendered;
  try {
    rendered = await renderSitePage({ blocks: content.blocks, resolveLink });
  } catch (error) {
    if (error instanceof SiteRenderError) {
      console.error('[site] render failed:', error.message, error.cause);
      throw serviceUnavailable(request);
    }
    throw error;
  }

  // Cover image: the JSON wrapper's metadata wins, with the legacy DB columns
  // as a fallback for pages saved before covers moved into content.json.
  const coverImage =
    content.coverImage ||
    (page.header_image_url
      ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
      : null);

  return {
    title: page.title || 'Untitled',
    html: siteArticleWrapper(rendered.html),
    coverImage,
  };
}

function serviceUnavailable(request: Request): Response {
  return new Response('unavailable', {
    status: 503,
    headers: siteHeaders({ request, cacheable: false, noindex: true }),
  });
}

/**
 * A short plain-text description derived from the document, for `og:description`.
 *
 * Taken from the rendered HTML rather than the block tree so it reflects what
 * a reader actually sees (a callout's text counts; a video URL does not).
 */
export function describeFromHtml(html: string): string | null {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 20) return null;
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text;
}
