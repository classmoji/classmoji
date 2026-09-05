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
import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
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
    } | null;
  } | null;
}

/** The classroom this request was authorized against, for the text read below. */
type MatchedClassroom = NonNullable<ContentRouteMembership['classroom']>;

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
          // or to shared theme assets (.slidesthemes folder)
          const isSlideContent = path.startsWith(slide.content_path);
          const isSharedAsset = path.startsWith('.slidesthemes/');

          if (isSlideContent || isSharedAsset) {
            hasAccess = true;
            matched = slide.classroom;
          }
        }
      }
    }
  }

  if (!hasAccess) {
    throw new Response('Forbidden - no access to this content', { status: 403 });
  }

  // 4. Proceed with fetch.
  //
  // Text goes through the asset map like every other read now, so an old
  // `/content/...` link serves the same bytes the loaders do rather than
  // whatever GitHub Pages last built. Binary falls through to the legacy
  // ladder — the delivery layer hands those out as signed URLs at render time,
  // so nothing new arrives here for them.
  const binary = isBinaryFile(path);
  const result = binary
    ? await fetchContent({ org, repo, path, binary })
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
