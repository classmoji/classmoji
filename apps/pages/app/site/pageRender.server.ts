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
import { collectBlockAssetRefs, mapBlockAssetRefs } from '@classmoji/utils';
import { assetResolveContext } from '~/utils/assetRefs.server.ts';

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

  // Render-time URL resolution. The lifetime comes from the PAGE's visibility,
  // through the same `tierFor` the pages app calls — not from the fact that
  // this is the class site. A public page is `month` here and `month` in the
  // app, which is what makes the two URLs identical inside a bucket; a
  // members-only page reached by a signed-in member is `week` on both, so its
  // URLs expire on the shorter bucket rather than borrowing the lifetime meant
  // for anonymous readers. Nothing on this surface can edit, so `canEdit` is
  // pinned false. The rewrite runs on a CLONE — `loadSitePageContent` caches
  // its blocks for five minutes, and writing signed URLs into that cache would
  // hand the next reader this reader's (expiring, tier-specific) URLs.
  const assetCtx = assetResolveContext(
    context.site.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    ClassmojiService.contentDelivery.tierFor({ canEdit: false, isPublic: page.is_public })
  );
  const { blocks: resolvedBlocks, srcSets } = await resolveSiteAssets(assetCtx, content.blocks);

  let rendered;
  try {
    rendered = await renderSitePage({
      blocks: resolvedBlocks,
      resolveLink,
      // Keyed by the signed URL, because the blocks now hold signed URLs.
      srcSets,
      // The site's setting, not the viewer's: `/schedule` 404s for everyone
      // when it is off, so a directory tile pointing at it is dropped.
      showSchedule: context.site.show_schedule === true,
    });
  } catch (error) {
    if (error instanceof SiteRenderError) {
      console.error('[site] render failed:', error.message, error.cause);
      throw serviceUnavailable(request);
    }
    throw error;
  }

  // Cover image: the JSON wrapper's metadata wins, with the legacy DB columns
  // as a fallback for pages saved before covers moved into content.json.
  const rawCover =
    content.coverImage ||
    (page.header_image_url
      ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
      : null);

  // The cover is markup this app renders itself, so it takes the signed URL
  // directly rather than going through the block rewrite — but under the same
  // guard: this is the anonymous, cached path, and a database hiccup resolving
  // one image must degrade to the stored reference, not 500 the site.
  const coverImage = await resolveSiteCover(assetCtx, rawCover);

  return {
    title: page.title || 'Untitled',
    html: siteArticleWrapper(rendered.html),
    coverImage,
  };
}

/**
 * Resolve a document's asset references for the public site.
 *
 * Failure is not fatal: a resolve that throws leaves the ORIGINAL blocks, which
 * render through the legacy URLs. A site that shows images from the old path is
 * strictly better than a 503, and this is the one surface with anonymous
 * readers and a shared cache in front of it.
 */
async function resolveSiteAssets(
  ctx: ReturnType<typeof assetResolveContext>,
  blocks: unknown[]
): Promise<{ blocks: unknown[]; srcSets: Record<string, string> }> {
  if (!ctx) return { blocks, srcSets: {} };

  const refs = collectBlockAssetRefs(blocks);
  if (refs.length === 0) return { blocks, srcSets: {} };

  try {
    // ONE pass: the URLs and the candidate lists come out of the same map read
    // under the same clock, so the `src` a block ends up with is exactly the
    // key its candidate list is filed under.
    const { urls, srcSets } = await ClassmojiService.contentDelivery.resolveDelivery(ctx, refs, {
      srcSets: true,
    });
    const bySignedUrl: Record<string, string> = {};
    for (const set of srcSets.values()) bySignedUrl[set.src] = set.srcset;
    return {
      blocks: mapBlockAssetRefs(blocks, ref => urls.get(ref) ?? ref),
      srcSets: bySignedUrl,
    };
  } catch (error) {
    console.warn('[site] asset resolution failed, rendering stored refs:', error);
    return { blocks, srcSets: {} };
  }
}

/**
 * Resolve the cover image, or leave it exactly as stored.
 *
 * Same contract as `resolveSiteAssets`, for the same reason — these are the two
 * resolves on the anonymous path, and neither is worth a 503.
 */
async function resolveSiteCover(
  ctx: ReturnType<typeof assetResolveContext>,
  cover: { url: string; position?: number } | null
): Promise<{ url: string; position?: number } | null> {
  if (!ctx || !cover?.url) return cover;

  try {
    return {
      ...cover,
      // A single capped rendition, not a candidate list. The cover is painted
      // as a CSS `background-image`, where `srcset` does not exist — so the
      // only lever is the URL itself, and an instructor's untouched camera
      // JPEG at the top of a public page is the single heaviest thing a class
      // site serves. 2560 is the widest rung the pipeline offers, still an
      // honest full-bleed banner on a retina display, and `fmt=auto` takes the
      // WebP/AVIF saving on top.
      url: await ClassmojiService.contentDelivery.resolveAssetUrl(ctx, cover.url, {
        transform: { w: 2560, fmt: 'auto' },
      }),
    };
  } catch (error) {
    console.warn('[site] cover resolution failed, rendering the stored ref:', error);
    return cover;
  }
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
