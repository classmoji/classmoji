import type { Role } from '@classmoji/database/client';

import { ClassmojiService } from '~/utils/db.server.ts';
import { assetResolveContext } from '~/utils/assetRefs.server.ts';
import { readerPayloadDeps } from '~/utils/readerDeps.server.ts';
import {
  buildReaderPayload,
  type ReaderClassroom,
  type ReaderLinkPolicy,
  type ReaderViewer,
} from '~/utils/readerPayload.server.ts';
import { describeBlocks, type ReaderPayload } from '~/utils/readerPayload.ts';
import {
  NO_SECTION_VIEWER,
  classroomOpenFor,
  documentForSite,
  readerSectionsFor,
  type SectionViewerAccess,
} from '~/utils/pageSections.server.ts';
import { ownFrameHosts } from '~/utils/frameHosts.server.ts';
import { NAV_GRID_SCHEDULE_PATH } from '~/components/editor/blocks/navGridShared.ts';
import { readerIslandAssets } from '~/reader-island/assets.server.ts';
import type { ReaderIslandData } from '~/reader-island/contract.ts';
import type { ReaderIslandAssets } from '~/reader-island/ReaderIsland.tsx';
import {
  loadSitePageContent,
  SiteContentUnavailableError,
  type SitePageContent,
} from './content.server.ts';
import { siteHeaders, type SiteReaderPolicy } from './headers.server.ts';
import { pagesUrl } from './env.server.ts';
import { signInPathFor } from './returnTo.ts';
import { coverWithoutUnresolvedMediaRef } from './siteMedia.server.ts';
import {
  publicPathOf,
  sitePagePath,
  type SiteContext,
  type SiteLoaderArgs,
  type SiteViewer,
  type SiteWithClassroom,
} from './tenant.server.ts';

/**
 * One page of a class site, as the shared reader shows it.
 *
 * `/` (home), `/{slug}` and `GET /api/page-reader` (a member's reader after an
 * unlock) all build what the reader island mounts from here, so the three can
 * never disagree about a viewer:
 *
 *  - The reader's viewer is the SITE's (`siteReaderViewer`): built from an
 *    ACCEPTED member's accepted memberships ONLY — never the app's
 *    any-invite-state rule, never the render route's staff viewer; for a
 *    signed-in user whose only membership here is PENDING, a reading viewer
 *    (members-only pages and their links, as the app gives them, and nothing
 *    else: no reader state, comments, downloads, locked bodies or drafts,
 *    whatever role the pending row names); null for everyone else (anonymous,
 *    a signed-in stranger, a member of another classroom, every visitor of a
 *    custom domain).
 *  - The payload is the one builder every surface uses (`buildReaderPayload`):
 *    locked bodies, link redaction, code, unresolved media and the URL maps are
 *    all decided there, for this viewer. A non-member's payload is therefore
 *    the same for every non-member: no tick boxes, no comments, no downloads,
 *    locked sections behind the site's sign-in gate. The one difference is
 *    `readerSections.signedIn`, true for a signed-in non-member, whose locked
 *    sections say only members can unlock them (sign-in would not help).
 *  - Links follow the site's own rule (`siteLinkPolicy`): a page this viewer
 *    could open on the site, at its site path; the schedule tile only when the
 *    site serves `/schedule`.
 *
 * The page body is NOT server-rendered any more: the island draws it in the
 * browser. The title, cover, description and og tags still are, and the
 * description is built from the non-member document whoever is reading
 * (`siteDescription`).
 */

/** The page row fields the site reads. */
export type SitePageRow = {
  id: string;
  classroom_id: string;
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

/** What a site page route renders. */
export type SitePageView = {
  title: string;
  /** The cover, ready to paint (a capped rendition), or null. Drawn by the site. */
  coverImage: { url: string; position?: number } | null;
  /** For `<meta name=description>` / `og:description`, from the non-member document. */
  description: string | null;
  /** The page is still legacy HTML in git and shows empty; staff are told why. */
  legacyFormat: boolean;
  /** What the reader island mounts with (serialized into the document). */
  island: ReaderIslandData;
  /** Where the island's files are. */
  assets: ReaderIslandAssets;
};

/**
 * Read the page's content for the site, or throw a 503 (never a cacheable
 * empty 200) when the content repo cannot be read or the document is corrupt.
 */
export async function readSitePageContent(
  request: Request,
  page: SitePageRow,
  classroom: SiteWithClassroom['classroom']
): Promise<SitePageContent> {
  try {
    return await loadSitePageContent(
      page,
      classroom as unknown as Parameters<typeof loadSitePageContent>[1]
    );
  } catch (error) {
    if (error instanceof SiteContentUnavailableError) {
      console.error('[site] content unavailable:', error.message, error.status);
      throw serviceUnavailable(request);
    }
    throw error;
  }
}

/**
 * The reader's viewer on the class site: for a visitor holding an ACCEPTED
 * membership in the site's classroom, the reader rule computed from those
 * memberships alone, with their own ticks and unlocks; for one whose only
 * membership is pending, `pendingReaderViewer`; else null.
 */
export async function siteReaderViewer(
  viewer: SiteViewer,
  page: Pick<SitePageRow, 'id'>,
  classroom: Pick<SiteWithClassroom['classroom'], 'status'>
): Promise<ReaderViewer | null> {
  if (!viewer.userId) return null;
  if (viewer.role === null || viewer.acceptedRoles.length === 0) {
    return pendingReaderViewer(viewer);
  }
  const access = ClassmojiService.pageSections.sectionViewerFromMemberships(
    viewer.acceptedRoles.map(role => ({ role, has_accepted_invite: true }))
  ) as SectionViewerAccess;
  if (access.acceptedRole === null) return null;
  const state = await ClassmojiService.pageSections.readerState({
    pageId: page.id,
    userId: viewer.userId,
  });
  return {
    userId: viewer.userId,
    access,
    readerSections: readerSectionsFor({
      signedIn: true,
      viewer: access,
      impersonated: viewer.impersonated,
      classroomOpen: classroomOpenFor({ status: classroom.status, viewer: access }),
      state,
    }),
    impersonated: viewer.impersonated,
  };
}

/**
 * The site's reader for a signed-in user whose only membership in the
 * classroom is pending: the role, so they read members-only pages and get
 * their links (`SITE_LINK_POLICY` reads `access.role`), and no ability at all
 * (`NO_SECTION_VIEWER`: no accepted role, nothing revealed, no drafts). No
 * reader state is read; their section state is a signed-in non-member's.
 * Null when there is no pending row either.
 */
function pendingReaderViewer(viewer: SiteViewer): ReaderViewer | null {
  if (!viewer.userId || viewer.role !== null || !viewer.pendingRole) return null;
  const access: SectionViewerAccess = { ...NO_SECTION_VIEWER, role: viewer.pendingRole };
  return {
    userId: viewer.userId,
    access,
    readerSections: readerSectionsFor({
      signedIn: true,
      viewer: access,
      impersonated: viewer.impersonated,
      classroomOpen: false,
      state: null,
    }),
    impersonated: viewer.impersonated,
  };
}

/**
 * The site's link rule: a linked page is a link when the site would serve it
 * to this viewer (never a draft; a members-only page only to a member or a
 * pending one), at its site path. `access.role` on the site is the accepted
 * role, or a pending row's for a reading viewer (`siteReaderViewer`). An
 * anonymous map can hold no members-only page.
 */
export const SITE_LINK_POLICY: ReaderLinkPolicy = {
  canOpen: (page, viewer) =>
    ClassmojiService.site.isPageVisibleOnSite(
      page,
      viewer ? ((viewer.access.role as Role | null) ?? null) : null
    ),
  href: page => sitePagePath(page),
};

/** The site's description: the non-member document's text, whoever is reading. */
export function siteDescription(
  content: Pick<SitePageContent, 'format' | 'blocks'>
): string | null {
  return describeBlocks(content.format === 'json' ? documentForSite(content.blocks) : []);
}

/**
 * The reader payload for this viewer of this page of this site: the ONE
 * function the site routes and `/api/page-reader` call.
 */
export async function buildSitePayload({
  site,
  viewer,
  page,
  content,
  signInUrl,
}: {
  site: SiteWithClassroom;
  viewer: SiteViewer;
  page: SitePageRow;
  content: SitePageContent;
  /** A non-member's way in: the site's sign-in, returning to this page. */
  signInUrl: string;
}): Promise<ReaderPayload> {
  const readerViewer = await siteReaderViewer(viewer, page, site.classroom);
  return buildReaderPayload(
    {
      content: { blocks: content.blocks, cover: content.coverImage, format: content.format },
      page,
      classroom: site.classroom as unknown as ReaderClassroom,
      viewer: readerViewer,
      // A signed-in non-member: told only members unlock (no sign-in loop).
      signedIn: Boolean(viewer.userId),
      frameHosts: ownFrameHosts(),
      options: {
        // The lifetime comes from the PAGE's visibility (the same `tierFor`
        // the pages app calls), never from the surface; nothing here edits.
        tier: ClassmojiService.contentDelivery.tierFor({
          canEdit: false,
          isPublic: page.is_public,
        }),
        previewActive: false,
        surface: 'site',
      },
      // Not branched on a session: every non-member gets the same link.
      signInUrl: () => signInUrl,
      links: SITE_LINK_POLICY,
      // The site's setting: `/schedule` 404s for everyone when it is off.
      scheduleHref: async () => (site.show_schedule === true ? NAV_GRID_SCHEDULE_PATH : null),
    },
    readerPayloadDeps
  );
}

/** The island data for a site payload. */
export function siteIslandData(page: SitePageRow, payload: ReaderPayload): ReaderIslandData {
  return {
    surface: 'site',
    page: {
      id: page.id,
      title: page.title,
      width: page.width ?? null,
      is_draft: page.is_draft,
    },
    payload,
    classroomSlug: null,
    // Same origin: on the subdomain the reader's calls pass through to this
    // app's own API routes; a custom domain's payload makes none.
    apiBase: '',
    // Download links go to the pages host, where the session lives.
    downloadOrigin: pagesUrl(),
  };
}

/**
 * The CSP a site document mounting the island needs: scripts from this
 * origin's `/assets/` in a build ('self' in dev), and connections to this
 * origin only on the class subdomain (none on a custom domain).
 */
export function siteReaderPolicy(request: Request, context: SiteContext): SiteReaderPolicy {
  return {
    assetsOrigin: import.meta.env?.DEV ? null : new URL(request.url).origin,
    connect: !context.customDomain,
  };
}

/**
 * Load and build a page of the site for the current viewer. Throws a 503
 * Response when the content cannot be read (never a cacheable empty page).
 */
export async function loadSitePageView(
  args: SiteLoaderArgs,
  context: SiteContext,
  page: SitePageRow
): Promise<SitePageView> {
  const content = await readSitePageContent(args.request, page, context.site.classroom);

  // The site's sign-in interstitial, returning to this page; on a custom
  // domain an absolute link to the subdomain, where a session can exist.
  const publicPath = publicPathOf(args.url.pathname, args.params.subdomain ?? '');
  const signInUrl = `${context.memberLinkOrigin}${signInPathFor(publicPath)}`;

  const payload = await buildSitePayload({
    site: context.site,
    viewer: context.viewer,
    page,
    content,
    signInUrl,
  });
  await auditViewAsLoad(args.request, context, page, payload);

  // The cover is drawn by the site (above the title, as it always was), from
  // the cover the payload SHIPS (already gone when it could not be resolved),
  // as one capped rendition.
  const assetCtx = assetResolveContext(
    context.site.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    ClassmojiService.contentDelivery.tierFor({ canEdit: false, isPublic: page.is_public })
  );
  const coverImage = coverWithoutUnresolvedMediaRef(
    await resolveSiteCover(assetCtx, payload.coverImage)
  );

  return {
    title: page.title || 'Untitled',
    coverImage,
    description: siteDescription(content),
    legacyFormat: content.format === 'html',
    island: siteIslandData(page, payload),
    assets: readerIslandAssets,
  };
}

/**
 * "View as" on a site page: a platform admin reading another user's state on
 * it. When the payload carries that user's reader state (they are an accepted
 * member here), one VIEW row for the load, the same row `/api/page-reader`
 * writes (`data.tool: 'page_reader'`, `via: 'site'`, `impersonated_by`). A
 * user loading their own page, and any load that ships no reader state (a
 * non-member, a pending member), writes nothing; a HEAD shows no one
 * anything. A failed log line must not fail the page: it is reported
 * (`audit_miss`) and the page loads.
 */
async function auditViewAsLoad(
  request: Request,
  context: SiteContext,
  page: Pick<SitePageRow, 'id'>,
  payload: ReaderPayload
): Promise<void> {
  const { viewer } = context;
  if (!viewer.impersonated || !viewer.userId || viewer.role === null) return;
  if (!payload.readerSections.member || request.method === 'HEAD') return;
  await ClassmojiService.audit.record({
    user_id: viewer.userId,
    classroom_id: context.site.classroom_id,
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

/**
 * Resolve the cover image, or leave it exactly as stored.
 *
 * A single capped rendition, not a candidate list: the cover is painted as a
 * CSS `background-image`, where `srcset` does not exist, so the only lever is
 * the URL itself. 2560 is the widest rung the pipeline offers and `fmt=auto`
 * takes the WebP/AVIF saving. A failed resolve degrades to the stored
 * reference, never a 503: this is the anonymous, cached path.
 */
export async function resolveSiteCover(
  ctx: ReturnType<typeof assetResolveContext>,
  cover: { url: string; position?: number } | null
): Promise<{ url: string; position?: number } | null> {
  if (!ctx || !cover?.url) return cover;

  try {
    return {
      ...cover,
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
