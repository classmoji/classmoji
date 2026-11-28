import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { withLogin } from '@classmoji/utils';
import { reportError } from '@classmoji/utils/error-report';
import { sentryBrowserConfig } from '@classmoji/utils/sentry';
import { getAuthSession } from '@classmoji/auth/server';
import type { Prisma } from '@classmoji/database/client';
import { redirect } from 'react-router';

/**
 * The user the root loader returns: each membership as the client reads it,
 * its id, role and classroom.
 */
const ROOT_USER_INCLUDE = {
  // The classroom without the invite link's code (owner only), the plan
  // owner's or the creator's id: this payload goes to every member.
  classroom_memberships: {
    select: {
      id: true,
      role: true,
      classroom: { omit: { join_code: true, plan_owner_id: true, created_by: true } },
    },
  },
  ...GIT_IDENTITY,
} as const satisfies Prisma.UserInclude;

type SlidesAppUser = ReturnType<
  typeof withLogin<Prisma.UserGetPayload<{ include: typeof ROOT_USER_INCLUDE }>>
>;

/**
 * Whether this session is a platform admin viewing as someone (better-auth's
 * admin plugin sets `session.impersonatedBy`): the browser then names no user.
 */
const isImpersonated = (authData: { session?: unknown }): boolean =>
  Boolean(
    (authData.session as { session?: { impersonatedBy?: unknown } } | undefined)?.session
      ?.impersonatedBy
  );

const loadRoot = async ({ request, url }: { request: Request; url: URL }) => {
  // Allow public access to /follow routes with valid shareCode
  // These routes handle their own authorization via shareCode validation
  const isFollowRoute = url.pathname.match(/^\/[^/]+\/follow$/);
  const hasShareCode = url.searchParams.has('shareCode');

  if (isFollowRoute && hasShareCode) {
    // Skip auth for public follow links - route will validate shareCode
    return { user: null, isPublicAccess: true };
  }

  // Check if this is a potential slideId route (UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  // Routes: /$slideId, /$slideId/follow, /$slideId/present, /$slideId/speaker
  // Excludes: /$classroomSlug/new, /$classroomSlug/$slideId/delete, /content/*
  const slideIdMatch = url.pathname.match(
    /^\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(?:follow|present|speaker))?$/i
  );

  if (slideIdMatch) {
    const potentialSlideId = slideIdMatch[1];

    // Check if this slide exists and is public
    try {
      const slide = await getPrisma().slide.findUnique({
        where: { id: potentialSlideId },
        select: { is_public: true, is_draft: true },
      });

      // If slide is public (and not draft), allow unauthenticated access
      // The child route will handle the actual authorization
      if (slide && slide.is_public && !slide.is_draft) {
        return { user: null, isPublicAccess: true };
      }
    } catch {
      // If lookup fails, continue with normal auth flow
    }
  }

  // Use Better Auth for authentication
  const authData = await getAuthSession(request);

  if (!authData) {
    // Redirect to main app login
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(`${webappUrl}?redirect=${encodeURIComponent(url.href)}`);
  }

  // Get full user with classroom memberships
  let user: SlidesAppUser | null = null;
  try {
    const found = await getPrisma().user.findUnique({
      where: { id: authData.userId },
      include: ROOT_USER_INCLUDE,
    });
    user = found ? withLogin(found) : null;
  } catch (error: unknown) {
    console.error('User lookup failed:', error);
    // A database failure sends a signed-in user back to the web app: reported.
    reportError(error, { surface: 'slides.root.user_lookup' });
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(webappUrl);
  }

  return { user, impersonating: isImpersonated(authData) };
};

export const loader = async (args: { request: Request; url: URL }) => {
  const result = await loadRoot(args);
  if (result instanceof Response) return result;
  // Browser error tracking (DSN + environment), read from the server's env at
  // request time: runtime config, never baked into the bundle.
  return { ...result, sentry: sentryBrowserConfig(process.env) };
};
