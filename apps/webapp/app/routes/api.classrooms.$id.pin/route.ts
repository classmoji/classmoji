/**
 * Pin/unpin a classroom for the current user.
 *
 * POST /api/classrooms/:id/pin
 * Body: { role: string } — the membership role to pin (a user may have
 *   multiple memberships in the same classroom; pinning is per-membership).
 *
 * Toggles `pin_order` on the user's ClassroomMembership row. If currently
 * null, sets it to `max(pin_order) + 1` across all of this user's memberships.
 * If non-null, clears it. Returns `{ pin_order: number | null }`.
 *
 * Auth: any signed-in user — pinning is a personal organization feature,
 * not tied to a role.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);
  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  let role: string | null = null;
  try {
    const body = (await request.json()) as { role?: string };
    role = body?.role ?? null;
  } catch {
    /* no body / not JSON */
  }
  if (!role) {
    return new Response('Missing role', { status: 400 });
  }

  const prisma = getPrisma();
  const membership = await prisma.classroomMembership.findUnique({
    where: { classroom_id_user_id_role: { classroom_id: classroomId, user_id: userId, role: role as Role } },
    select: { id: true, pin_order: true },
  });
  if (!membership) {
    return new Response('Forbidden', { status: 403 });
  }

  const newPinOrder = await prisma.$transaction(async tx => {
    if (membership.pin_order != null) {
      await tx.classroomMembership.update({
        where: { id: membership.id },
        data: { pin_order: null },
      });
      return null;
    }
    // Scope: per user across all of their memberships.
    const agg = await tx.classroomMembership.aggregate({
      _max: { pin_order: true },
      where: { user_id: userId },
    });
    const next = (agg._max.pin_order ?? 0) + 1;
    await tx.classroomMembership.update({
      where: { id: membership.id },
      data: { pin_order: next },
    });
    return next;
  });

  return Response.json({ pin_order: newPinOrder });
};
