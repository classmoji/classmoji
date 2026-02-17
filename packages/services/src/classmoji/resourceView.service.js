import prisma from '@classmoji/database';

/**
 * Resource View Service
 * Manages page view tracking for presence indicators (Notion-style "who's viewing")
 */

const HISTORY_WINDOW_DAYS = 7;

/**
 * Normalize a URL pathname by stripping the role prefix and classroom slug.
 * Examples:
 *   /admin/cs101/pages/abc -> pages/abc
 *   /student/cs101/dashboard -> dashboard
 *   /assistant/cs101/modules/intro -> modules/intro
 *
 * @param {string} pathname - The full URL pathname
 * @returns {string} - Normalized path without role prefix and classroom slug
 */
export function normalizePath(pathname) {
  // Remove leading slash, split by /
  const segments = pathname.replace(/^\//, '').split('/');

  // Role prefixes that should be stripped
  const rolePatterns = ['admin', 'student', 'assistant'];

  if (rolePatterns.includes(segments[0])) {
    // Skip role (segments[0]) and classroom slug (segments[1])
    // Return everything after, or 'dashboard' if nothing left
    return segments.slice(2).join('/') || 'dashboard';
  }

  // For non-role paths (public routes like /$class/pages/$pageId)
  // Skip just the classroom slug (segments[0])
  return segments.slice(1).join('/') || 'dashboard';
}

/**
 * Record a page view (upsert pattern).
 * Creates a new record or updates last_viewed_at if exists.
 * Designed to be called fire-and-forget to avoid blocking page loads.
 *
 * @param {Object} params
 * @param {string} params.resourcePath - Normalized resource path
 * @param {string} params.userId - User ID
 * @param {string} params.classroomId - Classroom ID
 * @param {string} [params.viewedAsRole] - The role/view used (OWNER, STUDENT, etc.)
 * @returns {Promise<Object|null>} - The created/updated record or null on error
 */
export async function recordView({ resourcePath, userId, classroomId, viewedAsRole }) {
  if (!resourcePath || !userId || !classroomId) {
    console.warn('[ResourceView] Missing required fields', {
      resourcePath,
      userId,
      classroomId,
    });
    return null;
  }

  try {
    return await prisma.resourceView.upsert({
      where: {
        resource_path_user_id_classroom_id: {
          resource_path: resourcePath,
          user_id: userId,
          classroom_id: classroomId,
        },
      },
      create: {
        resource_path: resourcePath,
        user_id: userId,
        classroom_id: classroomId,
        viewed_as_role: viewedAsRole || null,
      },
      update: {
        last_viewed_at: new Date(),
        viewed_as_role: viewedAsRole || undefined, // Only update if provided
      },
    });
  } catch (error) {
    // Log but don't throw - this is fire-and-forget
    console.error('[ResourceView] Failed to record view:', error.message);
    return null;
  }
}

/**
 * Get recent viewers for a specific resource path in a classroom.
 * Returns viewers from the last N days, optionally excluding the current user.
 *
 * @param {Object} params
 * @param {string} params.resourcePath - Normalized resource path
 * @param {string} params.classroomId - Classroom ID
 * @param {string} [params.excludeUserId] - User ID to exclude (typically current user)
 * @param {number} [params.limit=10] - Maximum number of viewers to return
 * @param {boolean} [params.includeRoles=false] - Include classroom membership roles
 * @returns {Promise<Array>} - Array of { user, lastViewedAt, role? } objects
 */
export async function getRecentViewers({
  resourcePath,
  classroomId,
  excludeUserId = null,
  limit = 10,
  includeRoles = false,
}) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - HISTORY_WINDOW_DAYS);

    const whereClause = {
      resource_path: resourcePath,
      classroom_id: classroomId,
      last_viewed_at: {
        gte: cutoffDate,
      },
    };

    // Exclude current user from results if specified
    if (excludeUserId) {
      whereClause.user_id = { not: excludeUserId };
    }

    const views = await prisma.resourceView.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            login: true,
            image: true,
            provider_id: true,
          },
        },
      },
      orderBy: {
        last_viewed_at: 'desc',
      },
      take: limit,
    });

    // Fetch roles from membership as fallback for records without viewed_as_role
    const userRoles = await fetchUserRoles(views, classroomId, includeRoles);

    return views.map(view => buildViewerObject(view, userRoles, includeRoles));
  } catch (error) {
    // Log but return empty array to prevent page crashes
    console.error('[ResourceView] Failed to fetch recent viewers:', error.message);
    return [];
  }
}

/**
 * Shared helper: fetch user roles from classroom memberships
 */
async function fetchUserRoles(views, classroomId, includeRoles) {
  if (!includeRoles || views.length === 0) return {};

  const userIds = [...new Set(views.map(v => v.user.id))];
  const memberships = await prisma.classroomMembership.findMany({
    where: {
      classroom_id: classroomId,
      user_id: { in: userIds },
    },
    select: {
      user_id: true,
      role: true,
    },
  });
  return Object.fromEntries(memberships.map(m => [m.user_id, m.role]));
}

/**
 * Shared helper: build viewer object with avatar URL and optional role
 * Prioritizes stored viewed_as_role, falls back to membership lookup
 */
function buildViewerObject(view, userRoles, includeRoles) {
  const avatar_url =
    view.user.image ||
    (view.user.provider_id
      ? `https://avatars.githubusercontent.com/u/${view.user.provider_id}?v=4`
      : null);

  const viewerData = {
    user: {
      id: view.user.id,
      name: view.user.name,
      login: view.user.login,
      avatar_url,
    },
    lastViewedAt: view.last_viewed_at,
  };

  if (includeRoles) {
    // Use stored role from view record, fall back to membership for older records
    viewerData.role = view.viewed_as_role || userRoles[view.user.id] || null;
  }

  return viewerData;
}

/**
 * Get recent viewers for multiple resource paths in a single query.
 * Returns a map of resourcePath -> { viewers, totalCount }.
 * Useful for pages lists where we need viewers for many resources at once.
 *
 * @param {Object} params
 * @param {string[]} params.resourcePaths - Array of normalized resource paths
 * @param {string} params.classroomId - Classroom ID
 * @param {number} [params.limitPerPath=5] - Maximum viewers per resource
 * @param {boolean} [params.includeTotalCount=false] - Include total count per path
 * @param {boolean} [params.includeRoles=false] - Include classroom membership roles
 * @returns {Promise<Map<string, { viewers: Array, totalCount?: number }>>}
 */
export async function getRecentViewersForPaths({
  resourcePaths,
  classroomId,
  limitPerPath = 5,
  includeTotalCount = false,
  includeRoles = false,
}) {
  const result = new Map();

  if (!resourcePaths?.length || !classroomId) {
    return result;
  }

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - HISTORY_WINDOW_DAYS);

    // Fetch all views for the given paths in one query
    const views = await prisma.resourceView.findMany({
      where: {
        resource_path: { in: resourcePaths },
        classroom_id: classroomId,
        last_viewed_at: { gte: cutoffDate },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            login: true,
            image: true,
            provider_id: true,
          },
        },
      },
      orderBy: { last_viewed_at: 'desc' },
    });

    // Fetch roles using shared helper
    const userRoles = await fetchUserRoles(views, classroomId, includeRoles);

    // Group views by resource_path, track total counts
    const groupedViews = {};
    const totalCounts = {};

    for (const view of views) {
      if (!groupedViews[view.resource_path]) {
        groupedViews[view.resource_path] = [];
        totalCounts[view.resource_path] = 0;
      }

      // Always count for total
      totalCounts[view.resource_path]++;

      // Only add to viewers array if under the limit
      if (groupedViews[view.resource_path].length < limitPerPath) {
        groupedViews[view.resource_path].push(buildViewerObject(view, userRoles, includeRoles));
      }
    }

    // Convert to Map with optional totalCount
    for (const [path, viewers] of Object.entries(groupedViews)) {
      if (includeTotalCount) {
        result.set(path, { viewers, totalCount: totalCounts[path] });
      } else {
        result.set(path, viewers);
      }
    }

    return result;
  } catch (error) {
    console.error('[ResourceView] Failed to fetch viewers for paths:', error.message);
    return result;
  }
}

/**
 * Clean up old views beyond the history window.
 * Can be run periodically via cron/scheduled task.
 *
 * @param {number} [daysToKeep=HISTORY_WINDOW_DAYS] - Days of history to retain
 * @returns {Promise<number>} - Number of records deleted
 */
export async function cleanupOldViews(daysToKeep = HISTORY_WINDOW_DAYS) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const result = await prisma.resourceView.deleteMany({
    where: {
      last_viewed_at: {
        lt: cutoffDate,
      },
    },
  });

  return result.count;
}
