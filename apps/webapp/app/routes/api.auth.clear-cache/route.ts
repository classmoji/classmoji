/**
 * DEV-ONLY: Clear the auth token cache for a specific user.
 * Used by integration tests to invalidate cached tokens between test scenarios.
 *
 * POST /api/auth/clear-cache
 * Body: { userId: string }
 */
import { clearTokenCache } from '@classmoji/auth/server';
import type { Route } from './+types/route';

export const action = async ({ request }: Route.ActionArgs) => {
  if (process.env.NODE_ENV !== 'development') {
    throw new Response('Not found', { status: 404 });
  }

  const { userId } = await request.json();
  clearTokenCache(userId || null);

  return Response.json({ cleared: true, userId: userId || 'all' });
};
