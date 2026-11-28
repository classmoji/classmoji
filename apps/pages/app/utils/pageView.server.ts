/**
 * pageView.server.ts — the loader behind `/_render/page/:pageId`.
 *
 * The MCP's `page_render` tool points a headless browser here so an agent
 * that edits a page blind can SEE it: the page's document — the LIVE collab
 * document when the classroom edits live, git main otherwise, or the pending
 * preview branch — drawn by the SHARED page reader (the one every reader
 * sees), mounted in the browser by the reader island (app/reader-island/),
 * with assets signed at the page's own visibility tier.
 *
 * Authorised by a view token in the `cm_view` cookie and nothing else: one
 * page, one target (`at:pin`), one host, 120 seconds. No session is read. The
 * root loader treats `/_render/` as a bare document (`RenderDocument`: no
 * hydration, no login redirect), so this loader is the only gate.
 *
 * Rendered for STAFF (`renderViewer`): every locked body is in, every page
 * of the classroom the document links to is a link (nothing is redacted as it
 * would be for an anonymous visitor) — the caller passed the MCP's read gate.
 * No comments, no downloads, no reader state: the payload asks the island
 * for no API call, and its CSP allows none.
 */

import { reportError } from '@classmoji/utils/error-report';
import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import {
  VIEW_HEADERS,
  parseViewQuery,
  viewTarget,
  viewTokenFromCookies,
  type PageViewMeta,
} from '@classmoji/services/render-contract';
import { verifyDocViewToken } from '@classmoji/services/render-token';
import { CollabRequestError } from '~/utils/collabEnv.server.ts';
import { fetchLiveSnapshot, liveEditingEnv } from '~/utils/collab.server.ts';
import { readerPayloadDeps } from '~/utils/readerDeps.server.ts';
import { ownFrameHosts } from '~/utils/frameHosts.server.ts';
import {
  buildReaderPayload,
  type ReaderLinkPolicy,
  type ReaderViewer,
} from '~/utils/readerPayload.server.ts';
import { NO_SECTION_VIEWER } from '~/utils/pageSections.server.ts';
import { readerIslandAssets } from '~/reader-island/assets.server.ts';
import type { ReaderIslandData } from '~/reader-island/contract.ts';
import type { ReaderIslandAssets } from '~/reader-island/ReaderIsland.tsx';

/** The ONE refusal: unknown page, bad token and unreadable content look identical. */
export function pageViewRefusal(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      ...VIEW_HEADERS,
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export interface PageViewData {
  /** What the island mounts the reader with. */
  island: ReaderIslandData;
  /** Where the island's files are (dev source or build). */
  assets: ReaderIslandAssets;
  meta: PageViewMeta;
}

/**
 * The render's reader: staff. Every locked body is shown and nothing is
 * recorded; no session, so no comments, no downloads and no reader state.
 */
function renderViewer(): ReaderViewer {
  return {
    // The view token names no one: nothing here is read or written per user.
    userId: '',
    access: { ...NO_SECTION_VIEWER, revealAll: true },
    readerSections: {
      staff: true,
      signedIn: false,
      member: false,
      showChecks: false,
      showUnlock: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    },
    impersonated: false,
  };
}

/**
 * The render's link rule, as the render page always drew links: every page
 * of the classroom that the document names (the builder looks them up in the
 * page's own classroom only) is a link with its live title; it goes nowhere
 * (`#`) — a screenshot has no one to follow it.
 */
const RENDER_LINK_POLICY: ReaderLinkPolicy = {
  canOpen: () => true,
  href: () => '#',
};

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
    // A copy that is not there or a document that does not parse is the
    // content, not a fault of the service.
    const unreadable = (error as { code?: unknown } | null)?.code === 'PAGE_CONTENT_UNREADABLE';
    if (!unreadable && (error as { status?: unknown } | null)?.status !== 404) {
      reportError(error, { surface: 'pages.render_page.load', tags: { page_id: page.id, at } });
    }
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

  const payload = await buildReaderPayload(
    {
      content: { blocks: loaded.blocks, cover: loaded.coverImage, format: 'json' },
      page,
      classroom: page.classroom as unknown as { id: string },
      viewer: renderViewer(),
      // The same frame rule as every reader: a PDF not of the class's own is a card.
      frameHosts: ownFrameHosts(),
      options: {
        tier: ClassmojiService.contentDelivery.tierFor({
          canEdit: false,
          isPublic: page.is_public,
        }),
        previewActive: query.at === 'preview',
        surface: 'render',
        offerDownloads: false,
        comments: false,
      },
      signInUrl: () => null,
      links: RENDER_LINK_POLICY,
      // No schedule tile: the render never drew one.
      scheduleHref: async () => null,
    },
    readerPayloadDeps
  );

  return {
    island: {
      surface: 'render',
      page: {
        id: page.id,
        title: page.title || 'Untitled',
        width: page.width,
        is_draft: page.is_draft,
      },
      payload,
    },
    assets: readerIslandAssets,
    meta: { kind: 'page', version: loaded.version },
  };
}
