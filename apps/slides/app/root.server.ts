import getPrisma from '@classmoji/database';
import { getAuthSession } from '@classmoji/auth/server';
import type { Prisma } from '@prisma/client';
import { redirect } from 'react-router';

type SlidesAppUser = Prisma.UserGetPayload<{
  include: {
    classroom_memberships: {
      include: {
        classroom: true;
      };
    };
  };
}>;

export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);

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
  const slideIdMatch = url.pathname.match(/^\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(?:follow|present|speaker))?$/i);

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
    user = await getPrisma().user.findUnique({
      where: { id: authData.userId },
      include: {
        classroom_memberships: {
          include: {
            classroom: true,
          },
        },
      },
    });
  } catch (error: unknown) {
    console.error('User lookup failed:', error);
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(webappUrl);
  }

  return { user };
};
