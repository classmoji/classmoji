/**
 * Mark the in-classroom guided tour complete for the current user in a classroom.
 *
 * POST /api/classroom-tour/complete
 * Body: { classroomId: string, role?: 'OWNER' | 'STUDENT' | 'ASSISTANT' | 'TEACHER' }
 *
 * Stamps `tour_completed_at` on the caller's membership for that classroom. When
 * `role` is given, only that role's membership is marked, so a user who holds
 * both OWNER and STUDENT in the example sandbox can finish each walkthrough
 * independently. Scoped to the caller's own rows via user_id.
 * Returns `{ ok: true }`.
 *
 * Auth: any signed-in user — self-scoped, not role-gated.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import type { Route } from './+types/route';

const ROLES: Role[] = ['OWNER', 'STUDENT', 'ASSISTANT', 'TEACHER'];

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);

  let classroomId: string | null = null;
  let role: Role | undefined;
  try {
    const body = (await request.json()) as { classroomId?: string; role?: string };
    classroomId = body?.classroomId ?? null;
    role = ROLES.find(r => r === body?.role);
  } catch {
    /* no body / not JSON */
  }
  if (!classroomId) {
    return new Response('Missing classroomId', { status: 400 });
  }

  await getPrisma().classroomMembership.updateMany({
    where: { classroom_id: classroomId, user_id: userId, ...(role ? { role } : {}) },
    data: { tour_completed_at: new Date() },
  });

  return Response.json({ ok: true });
};
