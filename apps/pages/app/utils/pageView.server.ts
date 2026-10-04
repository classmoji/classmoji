/**
 * pageView.server.ts — the loader behind `/_render/page/:pageId`.
 *
 * The MCP's `page_render` tool points a headless browser here so an agent
 * that edits a page blind can SEE it: the page's document — the LIVE collab
 * document when the classroom edits live, git main otherwise, or the pending
 * preview branch — serialized by the same static BlockNote renderer the class
 * site uses, with assets signed at the page's own visibility tier.
 *
 * Authorised by a view token in the `cm_view` cookie and nothing else: one
 * page, one target (`at:pin`), one host, 120 seconds. No session is read. The
 * root loader treats `/_render/` like a site path (bare, script-less document,
 * no login redirect), so this loader is the only gate.
 *
 * Rendered for STAFF: every page link resolves (nothing is redacted as it
 * would be for an anonymous visitor) — the caller passed the MCP's read gate.
 */

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import {
  VIEW_HEADERS,
  parseViewQuery,
  viewTarget,
  viewTokenFromCookies,
  type PageViewMeta,
} from '@classmoji/services/render-contract';
import { verifyDocViewToken } from '@classmoji/services/render-token';
import { assetResolveContext } from '~/utils/assetRefs.server.ts';
import { CollabRequestError } from '~/utils/collabEnv.server.ts';
import { fetchLiveSnapshot, liveEditingEnv } from '~/utils/collab.server.ts';
import {
  resolveSiteAssets,
  resolveSiteCover,
  siteArticleWidthClass,
} from '~/site/pageRender.server.ts';
import { renderSitePage, siteArticleWrapper } from '~/site/render.server.ts';
import {
  withoutUnresolvedMediaRefs,
  coverWithoutUnresolvedMediaRef,
} from '~/site/siteMedia.server.ts';
import type { PageLinkResolver } from '~/site/viewerSchema.server.ts';

/** The ONE refusal: unknown page, bad token and unreadable content look identical. */
export function pageViewRefusal(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: { ...VIEW_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export interface PageViewData {
  title: string;
  html: string;
  coverImage: { url: string; position?: number } | null;
  widthClass: string;
  meta: PageViewMeta;
}

type Cover = { url: string; position?: number } | null;

async function loadViewBlocks(
  page: { id: string; content_path: string; classroom: unknown },
  at: 'main' | 'preview'
): Promise<{ blocks: unknown; coverImage: Cover; version: string } | null> {
  if (at === 'main') {
    const env = liveEditingEnv(page.classroom);
    if (env) {
      try {
        const snapshot = await fetchLiveSnapshot(env, page.id, { timeoutMs: 5000 });
        const content = snapshot.content as { blocks?: unknown; coverImage?: Cover };
        return {
          blocks: content.blocks ?? [],
          coverImage: content.coverImage ?? null,
          version: `live:${snapshot.epoch}.${snapshot.version}`,
        };
      } catch (error) {
        if (!(error instanceof CollabRequestError)) throw error;
        console.warn(`[render-page] live page unavailable for ${page.id}: ${error.message}`);
      }
    }
  }
  try {
    const content = await ClassmojiService.pageContent.loadPageContent(page as never, {
      skipCache: true,
      ...(at === 'preview'
        ? { ref: ClassmojiService.pageContent.previewBranchName(page.content_path) }
        : {}),
    });
    if (content.format !== 'json') return null;
    return {
      blocks: content.blocks,
      coverImage: (content.coverImage as Cover) ?? null,
      version: content.sha ?? 'unknown',
    };
  } catch (error) {
    console.warn(
      `[render-page] could not load ${at} for ${page.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export async function pageViewLoader({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}): Promise<PageViewData> {
  const { pageId } = params;
  const url = new URL(request.url);
  const query = parseViewQuery(url);
  if (!pageId || !query) throw pageViewRefusal();

  const page = await prisma.page.findUnique({
    where: { id: pageId },
    include: { classroom: { include: { git_organization: true } } },
  });

  const verification = page
    ? await verifyDocViewToken(viewTokenFromCookies(request.headers.get('cookie')), {
        origin: url.origin,
        classroomId: page.classroom_id,
        kind: 'page',
        docId: page.id,
        target: viewTarget(query.at, query.pin),
        keyVersion: page.classroom?.content_key_version,
      })
    : ({ ok: false, reason: 'malformed' } as const);

  if (!page || !verification.ok) {
    console.warn(
      `[render-page] Refused a render for ${pageId}: ${
        !page ? 'unknown-page' : 'reason' in verification ? verification.reason : 'refused'
      }`
    );
    throw pageViewRefusal();
  }

  const loaded = await loadViewBlocks(page, query.at);
  if (!loaded) throw pageViewRefusal();

  // Staff view: every page in the classroom resolves to a link.
  const siblings = await prisma.page.findMany({
    where: { classroom_id: page.classroom_id },
    select: { id: true, title: true },
  });
  const titles = new Map(siblings.map(p => [p.id, p.title || 'Untitled']));
  const resolveLink: PageLinkResolver = id =>
    titles.has(id) ? { href: '#', title: titles.get(id) ?? 'Untitled' } : null;

  const assetCtx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    ClassmojiService.contentDelivery.tierFor({ canEdit: false, isPublic: page.is_public })
  );
  const { blocks, srcSets } = await resolveSiteAssets(
    assetCtx,
    Array.isArray(loaded.blocks) ? loaded.blocks : []
  );
  const rendered = await renderSitePage({
    blocks: withoutUnresolvedMediaRefs(blocks),
    resolveLink,
    srcSets,
    showSchedule: false,
    downloads: {},
  });
  const coverImage = coverWithoutUnresolvedMediaRef(
    await resolveSiteCover(assetCtx, loaded.coverImage)
  );

  return {
    title: page.title || 'Untitled',
    html: siteArticleWrapper(rendered.html),
    coverImage,
    widthClass: siteArticleWidthClass(page.width),
    meta: { kind: 'page', version: loaded.version },
  };
}
