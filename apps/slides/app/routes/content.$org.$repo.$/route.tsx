/**
 * Content Proxy Route — LEGACY, kept for links already in the wild.
 *
 * Everything new goes through the delivery Worker: signed, sha-addressed URLs
 * minted at render time. This route survives because stored documents, browser
 * bookmarks and shared slide links still carry `/content/{org}/{repo}/{path}`,
 * and because it is the client-side fallback the deck surfaces hand their
 * presenter component.
 *
 * TEXT served from here now goes through the same map-first read the loaders
 * use (`fetchContentText`), so an old link is not a stale link. Binary files
 * keep the legacy `fetchContent` ladder: the delivery layer serves those as
 * signed URLs at the point of render, and there is nothing to gain from
 * re-plumbing a path nothing new points at.
 *
 * Serves CSS, fonts, and other assets with correct MIME types.
 *
 * URL pattern: /content/:org/:repo/*path
 * The :repo segment is the classroom's stored content repo — user-editable, so
 * it follows no derivable pattern.
 * Example: /content/myorg/cs101-content/.slidesthemes/theme/lib/offline-v2.css
 *
 * SECURITY: This route validates access via one of:
 * 1. Authenticated user with classroom membership
 * 2. Public slide access via ?slideId= parameter
 *
 * For public slides, the slideId is used to verify:
 * - The slide exists and is_public=true
 * - The requested content matches the slide's content repo
 *
 * Both of those authorize a PATH against a REPO. That holds for deck assets,
 * which have no visibility of their own, and not for the document behind a FILE
 * slide, which does — so a path that is a file slide's `source_path` is handed
 * to that slide's own view gate and, on success, redirected to `/{slideId}`
 * rather than served from here. See `~/utils/slideDocumentAccess`.
 *
 * PERFORMANCE: Classroom memberships are cached for 8 hours to avoid
 * hitting the database on every asset request (CSS, fonts, images, etc.).
 *
 * Benefits over direct CDN access:
 * - Correct MIME types (no ORB blocking)
 * - GitHub API fallback for new content
 * - Consistent with HTML content serving
 * - Can add caching headers later
 */

import { fetchContent, getMimeType, isBinaryFile } from '~/utils/contentProxy';
import { isWithinContentPath, slideDocumentDecision } from '~/utils/slideDocumentAccess';
import { assertSlideAccess, getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { SLIDE_FILE_EXTENSIONS } from '@classmoji/services/slides';
import { getContentRepoName } from '@classmoji/utils';
import getPrisma from '@classmoji/database';

interface ContentRouteMembership {
  classroom?: {
    id?: string;
    content_key_version?: number;
    content_delivery_enabled?: boolean | null;
    content_repo?: string | null;
    git_organization?: {
      login: string;
      settings?: Record<string, string> | null;
      // The other two thirds of `isDeliverableClassroom`. Carried because the
      // binary branch below has to know whether the delivery layer can SERVE
      // this classroom, not merely whether it was opted in — two answers that
      // parted company when `content_delivery_enabled` began defaulting to
      // true. Every branch that sets `matched` reads the row with
      // `git_organization` included, so this costs no extra query.
      provider?: string | null;
      github_installation_id?: string | null;
    } | null;
  } | null;
}

/** The classroom this request was authorized against, for the text read below. */
type MatchedClassroom = NonNullable<ContentRouteMembership['classroom']>;

/**
 * The ONE refusal this route gives.
 *
 * Every path a caller may not have is answered with the same status and the
 * same sentence, built in one place. Two `new Response('Forbidden…')` literals
 * drift, and the drift is an oracle for which paths exist.
 */
function forbidden(): Response {
  return new Response('Forbidden - no access to this content', { status: 403 });
}

// In-memory cache for user classroom memberships
// Avoids DB hit on every asset request (CSS, fonts, images, etc.)
// TTL matches auth package token cache (8 hours) since memberships rarely change
const membershipCache = new Map();
const MEMBERSHIP_CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours (matches auth token cache)

/**
 * Get user's classroom memberships with caching
 * @param {string} userId
 * @returns {Promise<Array>} classroom_memberships with nested classroom and git_organization
 */
async function getCachedMemberships(userId: string) {
  const cacheKey = `memberships:${userId}`;
  const cached = membershipCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    include: {
      classroom_memberships: {
        include: {
          classroom: {
            include: { git_organization: true },
          },
        },
      },
    },
  });

  const memberships = user?.classroom_memberships || [];
  membershipCache.set(cacheKey, {
    data: memberships,
    expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL,
  });

  return memberships;
}

/**
 * The map-first text read, degrading to the legacy ladder.
 *
 * `matched` is null only when access was granted by a branch that did not
 * resolve a classroom row — there is nothing to sign against then, and the
 * legacy ladder is the whole answer.
 */
async function fetchProxyText(
  matched: MatchedClassroom | null,
  org: string,
  repo: string,
  path: string
): Promise<{ content: string; source: string } | null> {
  if (matched?.id) {
    const text = await ClassmojiService.contentDelivery.fetchContentText(
      {
        classroom: {
          id: matched.id,
          content_key_version: matched.content_key_version ?? 0,
          content_repo: repo,
          content_delivery_enabled: matched.content_delivery_enabled === true,
          git_organization: { login: org },
        },
      },
      path,
      { label: 'proxy' }
    );
    if (text) return { content: text.text, source: text.source };
    return null;
  }

  // No classroom to sign against — the legacy ladder is the whole answer, and
  // it stays API-first because this is TEXT, where staleness is the expensive
  // failure (see fetchContent's header).
  const legacy = await fetchContent({ org, repo, path });
  return legacy ? { content: legacy.content as string, source: legacy.source } : null;
}

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { org, repo } = params;
  const path = params['*']; // Catch-all segment
  const url = new URL(request.url);
  const slideId = url.searchParams.get('slideId');

  if (!org || !repo || !path) {
    throw new Response('Invalid request', { status: 400 });
  }

  // Try authentication first
  const authData = await getAuthSession(request);
  let hasAccess = false;
  // Kept from whichever branch granted access: the text read below needs the
  // classroom's id and cache version to sign, and its org/repo to fall back.
  let matched: MatchedClassroom | null = null;
  // Every classroom this request was authorized AGAINST — not just the one the
  // text read signs under. The membership branch can match several classrooms
  // sharing one content repo, and the file-slide rule below has to look in all
  // of them, because the document belongs to whichever one holds it.
  let authorizedClassroomIds: string[] = [];

  // Path 1: Authenticated user - check classroom memberships
  if (authData) {
    const memberships = await getCachedMemberships(authData.userId);

    // STRICT validation: repo must EXACTLY match the content repo for a user's classroom.
    // The classroom's content repo is STORED and user-editable — never re-derived.
    // Legacy classrooms without one fall back to the ORG-level content repo
    // (organization.settings.content_repo_name).
    const matches = memberships.filter((m: ContentRouteMembership) => {
      const gitOrg = m.classroom?.git_organization;
      if (!gitOrg || gitOrg.login !== org) return false;

      // Get the expected content repo name for this classroom
      const expectedRepo = m.classroom?.content_repo
        ? m.classroom.content_repo
        : getContentRepoName({
            login: gitOrg.login,
            settings: gitOrg.settings as { content_repo_name?: string } | undefined,
          });

      return repo === expectedRepo; // EXACT match only
    });
    hasAccess = matches.length > 0;
    authorizedClassroomIds = matches
      .map((m: ContentRouteMembership) => m.classroom?.id)
      .filter((id: string | undefined): id is string => typeof id === 'string');

    // ONE match, or none — never "the first of several".
    //
    // Access is settled by `hasAccess` above and is unaffected by this. What
    // this decides is which classroom's ROLLOUT GATE and key version the text
    // read below signs under, and several of a user's classrooms can legitimately
    // share one content repo (the org-level `content_repo_name` fallback is
    // org-wide). Picking the first would let a classroom whose
    // `content_delivery_enabled` is still false have its text served through the
    // Worker because a sibling classroom on the same repo is switched on — which
    // is exactly the per-classroom rollout the flag exists to control.
    //
    // Ambiguity therefore reads as "no classroom", and the legacy ladder answers.
    matched = matches.length === 1 ? (matches[0].classroom ?? null) : null;
  }

  // Path 2: Public slide access - validate slideId points to a public slide
  if (!hasAccess && slideId) {
    const slide = await getPrisma().slide.findUnique({
      where: { id: slideId },
      include: {
        classroom: {
          include: { git_organization: true },
        },
      },
    });

    // Check if slide is public (and not draft)
    if (slide && slide.is_public && !slide.is_draft) {
      const gitOrg = slide.classroom?.git_organization;
      if (gitOrg && gitOrg.login === org) {
        // Validate the requested repo matches the slide's content repo (stored,
        // user-editable — never re-derived)
        const expectedRepo = slide.classroom.content_repo
          ? slide.classroom.content_repo
          : getContentRepoName({ login: gitOrg.login });

        if (repo === expectedRepo) {
          // For public slides, allow access to content in the slide's content_path
          // or to shared theme assets (.slidesthemes folder).
          //
          // The folder check is separator-aware: a bare prefix match on
          // `slides/week-1` also covers `slides/week-10/…`, and instructors
          // number their slugs exactly that way.
          const isSlideContent = isWithinContentPath(path, slide.content_path);
          const isSharedAsset = path.startsWith('.slidesthemes/');

          if (isSlideContent || isSharedAsset) {
            hasAccess = true;
            matched = slide.classroom;
            authorizedClassroomIds = slide.classroom.id ? [slide.classroom.id] : [];
          }
        }
      }
    }
  }

  if (!hasAccess) {
    throw forbidden();
  }

  // 3. An uploaded FILE slide's document is not one of this route's assets.
  //
  // The branches above authorize a PATH against a REPO, which is the right rule
  // for a deck: its `index.html`, its images and the shared themes are assets OF
  // the deck and carry no visibility of their own. A file slide's document does.
  // It lives in the same repo, at `slides/<slug>/<name>.pdf`, and the slide row
  // beside it holds the draft/private/public setting that `/{slideId}` enforces.
  // So when the requested path IS a file slide's `source_path`, that slide's own
  // view gate decides — the same `assertSlideAccess` call, at the same tier.
  //
  // On success the caller is sent to `/{slideId}` rather than served from here:
  // that route names the download, mints a short-lived signed URL where the
  // delivery layer is on, and marks the answer `no-store`. This one serves bytes
  // inline under `Cache-Control: public`, which is right for a font and wrong
  // for a document. On refusal the answer is the route's ordinary one, so a
  // path that exists and a path that does not read identically.
  const documentDecision = await slideDocumentDecision({
    path,
    classroomIds: authorizedClassroomIds,
    // The filter that keeps this off the hot path: every font, stylesheet and
    // image this route serves fails it before a query is made.
    extensions: SLIDE_FILE_EXTENSIONS,
    findFileSlides: (classroomIds, sourcePath) =>
      getPrisma().slide.findMany({
        where: {
          classroom_id: { in: [...classroomIds] },
          kind: 'FILE',
          source_path: sourcePath,
        },
        include: { classroom: { include: { git_organization: true } } },
      }),
    assertView: fileSlide =>
      assertSlideAccess({
        request,
        slideId: fileSlide.id,
        slide: fileSlide,
        accessType: 'view',
      }),
  });
  if (documentDecision.outcome === 'redirect') return documentDecision.response;
  if (documentDecision.outcome === 'refuse') throw forbidden();

  // 4. Proceed with fetch.
  //
  // Text goes through the asset map like every other read now, so an old
  // `/content/...` link serves the same bytes the loaders do rather than
  // whatever GitHub Pages last built. Binary falls through to the legacy
  // ladder — the delivery layer hands those out as signed URLs at render time,
  // so nothing new arrives here for them.
  const binary = isBinaryFile(path);
  // Binary keeps CDN-first for a classroom the layer does not SERVE. Every
  // image and font of every deck in such a classroom comes through here, and
  // those bytes never change once uploaded — so a few minutes of CDN staleness
  // is free where an authenticated read per image spends the org installation's
  // shared limit. A served classroom hands its assets out as signed URLs and
  // barely reaches this route at all, so API-first is right there. Unknown
  // classroom reads as "not served": the safe direction is the one that cannot
  // exhaust a rate limit.
  //
  // The question is `canDeliverContent`, not the flag. A classroom gated ON
  // whose org has no App installation is the worst case for API-first and the
  // one the flag alone gets wrong: it cannot mint a token, so its refs are never
  // signed and ALL of its binaries land here — and then each one attempts a
  // Contents-API read and a Git-Blobs read that can only throw "GitHub provider
  // requires github_installation_id", logging both failures per asset per
  // request, before reaching the CDN tier that was always going to answer.
  const preferCdn = !ClassmojiService.contentDelivery.canDeliverContent(matched);
  const result = binary
    ? await fetchContent({ org, repo, path, binary, preferCdn })
    : await fetchProxyText(matched, org, repo, path);

  if (!result) {
    throw new Response('Not found', { status: 404 });
  }

  // Get MIME type - pass content for magic byte detection on extensionless files
  const mimeType = getMimeType(path, binary ? (result.content as Buffer) : undefined);

  // Binary is versioned by path (hash-based filenames) and can be cached hard.
  // TEXT cannot: a deck's index.html lives at a stable path and changes on every
  // save, so an hour of browser caching here would put the staleness straight
  // back — in a bookmarked `/content/...` link and in the presenter's own
  // client-side fallback, which is the one place a stale deck is worst. A
  // minute keeps the proxy cheap without outliving a save by much.
  const headers = {
    'Content-Type': mimeType,
    'Cache-Control': binary ? 'public, max-age=3600' : 'public, max-age=60',
    'X-Content-Source': result.source, // Debug header
  };

  // For binary content, pass the Buffer directly
  if (binary) {
    const binaryContent =
      typeof result.content === 'string'
        ? new TextEncoder().encode(result.content)
        : Uint8Array.from(result.content);
    return new Response(binaryContent.buffer, { headers });
  }

  return new Response(result.content as string, { headers });
};
