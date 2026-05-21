/**
 * Reorder pinned classrooms.
 *
 * POST /api/classrooms/reorder-pins
 * Body: { ids: string[] }
 *
 * The order in the array is the new `pin_order` (1..N).
 * Auth: requires the user to have a teaching-team membership on EVERY
 * classroom in the payload; otherwise 403.
 *
 * Returns `{ ok: true }`.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

const TEACHING_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const ids =
    body && typeof body === 'object' && Array.isArray((body as { ids?: unknown }).ids)
      ? ((body as { ids: unknown[] }).ids.filter(v => typeof v === 'string') as string[])
      : null;

  if (!ids || ids.length === 0) {
    return new Response('Missing ids', { status: 400 });
  }

  const prisma = getPrisma();

  // Verify the user has a teaching-team membership on every classroom in the list.
  const memberships = await prisma.classroomMembership.findMany({
    where: {
      user_id: userId,
      classroom_id: { in: ids },
      role: { in: TEACHING_ROLES as unknown as string[] },
    },
    select: { classroom_id: true },
  });
  const allowed = new Set(memberships.map(m => m.classroom_id));
  if (ids.some(id => !allowed.has(id))) {
    return new Response('Forbidden', { status: 403 });
  }

  await prisma.$transaction(
    ids.map((id, idx) =>
      prisma.classroom.update({
        where: { id },
        data: { pin_order: idx + 1 },
      })
    )
  );

  return Response.json({ ok: true });
};
