/**
 * List the GitHub Classrooms the signed-in user administers.
 *
 * GET /api/github-classrooms → `{ classrooms: ListedClassroom[] }`
 *
 * Phase 1 of the live import: cheap metadata (name, archived, org) for the
 * picker. The heavy per-classroom fetch (assignments/submissions/grades) happens
 * later in the background import job. Uses the user's GitHub App user access
 * token; GitHub only returns classrooms where the user is an administrator.
 *
 * Returns `{ reauth: true, classrooms: [] }` (HTTP 200) when there's no usable
 * GitHub token so the UI can prompt a re-sign-in instead of erroring.
 */

import { getAuthSession, clearRevokedToken } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData) throw new Response('Unauthorized', { status: 401 });

  if (!authData.token) {
    return Response.json({ reauth: true, classrooms: [] });
  }

  try {
    const classrooms = await ClassmojiService.githubClassroomApi.listAdminClassrooms(
      authData.token
    );
    return Response.json({ classrooms });
  } catch (error: unknown) {
    // Revoked/expired token → clear it and ask the user to re-authenticate.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { status?: number }).status === 401
    ) {
      await clearRevokedToken(authData.userId);
      return Response.json({ reauth: true, classrooms: [] });
    }
    console.error('failed to list github classrooms:', error);
    return Response.json(
      { error: 'Could not load your GitHub Classrooms. Please try again.', classrooms: [] },
      { status: 502 }
    );
  }
};
