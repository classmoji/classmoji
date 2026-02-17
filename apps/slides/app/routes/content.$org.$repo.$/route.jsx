/**
 * Content Proxy Route
 *
 * Proxies content from GitHub repositories with CDN-first strategy.
 * Serves CSS, fonts, and other assets with correct MIME types.
 *
 * URL pattern: /content/:org/:repo/*path
 * Example: /content/myorg/content-myorg-25w/.slidesthemes/theme/lib/offline-v2.css
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
import { getContentRepoName } from '@classmoji/utils';
import prisma from '@classmoji/database';

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
async function getCachedMemberships(userId) {
  const cacheKey = `memberships:${userId}`;
  const cached = membershipCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const user = await prisma.user.findUnique({
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

export const loader = async ({ params, request }) => {
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

  // Path 1: Authenticated user - check classroom memberships
  if (authData) {
    const memberships = await getCachedMemberships(authData.userId);

    // STRICT validation: repo must EXACTLY match the content repo for a user's classroom
    // Content repo pattern: content-{org}-{term} (e.g., content-csc-25w)
    // Or explicitly set in organization.settings.content_repo_name
    hasAccess = memberships.some(m => {
      const gitOrg = m.classroom?.git_organization;
      if (!gitOrg || gitOrg.login !== org) return false;

      // Get the expected content repo name for this classroom
      const expectedRepo = getContentRepoName({
        login: gitOrg.login,
        term: m.classroom.term,
        year: m.classroom.year,
        settings: gitOrg.settings,
      });

      return repo === expectedRepo; // EXACT match only
    });
  }

  // Path 2: Public slide access - validate slideId points to a public slide
  if (!hasAccess && slideId) {
    const slide = await prisma.slide.findUnique({
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
        // Validate the requested repo matches the slide's content repo
        const expectedRepo = getContentRepoName({
          login: gitOrg.login,
          term: slide.classroom.term,
          year: slide.classroom.year,
          settings: gitOrg.settings,
        });

        if (repo === expectedRepo) {
          // For public slides, allow access to content in the slide's content_path
          // or to shared theme assets (.slidesthemes folder)
          const isSlideContent = path.startsWith(slide.content_path);
          const isSharedAsset = path.startsWith('.slidesthemes/');

          if (isSlideContent || isSharedAsset) {
            hasAccess = true;
          }
        }
      }
    }
  }

  if (!hasAccess) {
    throw new Response('Forbidden - no access to this content', { status: 403 });
  }

  // 4. Proceed with fetch
  const binary = isBinaryFile(path);
  const result = await fetchContent({ org, repo, path, binary });

  if (!result) {
    throw new Response('Not found', { status: 404 });
  }

  // Get MIME type - pass content for magic byte detection on extensionless files
  const mimeType = getMimeType(path, binary ? result.content : undefined);

  // Set cache headers - assets are versioned by path (hash-based filenames)
  // so they can be cached aggressively. 1 hour browser + CDN caching.
  const headers = {
    'Content-Type': mimeType,
    'Cache-Control': 'public, max-age=3600', // 1 hour
    'X-Content-Source': result.source, // Debug header
  };

  // For binary content, pass the Buffer directly
  if (binary) {
    return new Response(result.content, { headers });
  }

  return new Response(result.content, { headers });
};
