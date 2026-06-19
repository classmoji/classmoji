/**
 * Mark the current user's first-sign-in onboarding tour as complete.
 *
 * POST /api/onboarding/complete
 *
 * Stamps `onboarding_completed_at` on the signed-in user's row so the tour
 * does not show again (called when the user finishes OR skips the tour).
 * Returns `{ ok: true }`.
 *
 * Auth: any signed-in user — scoped to their own row only.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);

  await getPrisma().user.update({
    where: { id: userId },
    data: { onboarding_completed_at: new Date() },
  });

  return Response.json({ ok: true });
};
