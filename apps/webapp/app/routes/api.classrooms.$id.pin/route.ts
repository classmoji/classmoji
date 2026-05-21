/**
 * Pin/unpin a classroom for the current user.
 *
 * POST /api/classrooms/:id/pin
 *
 * Toggles `pin_order` on the classroom. If currently null, sets it to
 * `max(pin_order) + 1` scoped per `git_org_id` (the simpler scope — two orgs
 * may each have their own pin_order=1; the landing screen sorts within each).
 * If non-null, sets it back to null.
 *
 * Returns `{ pin_order: number | null }`.
 *
 * Auth: requires the user to be on the classroom's teaching team
 * (OWNER / TEACHER / ASSISTANT). Students cannot pin.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

const TEACHING_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);
  const id = params.id;
  if (!id) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const prisma = getPrisma();

  const classroom = await prisma.classroom.findUnique({
    where: { id },
    select: { id: true, git_org_id: true, pin_order: true },
  });
  if (!classroom) {
    return new Response('Not Found', { status: 404 });
  }

  // Authorize: user must have a teaching-team membership in this classroom.
  const membership = await prisma.classroomMembership.findFirst({
    where: {
      classroom_id: classroom.id,
      user_id: userId,
      role: { in: TEACHING_ROLES as unknown as string[] },
    },
    select: { id: true },
  });
  if (!membership) {
    return new Response('Forbidden', { status: 403 });
  }

  const newPinOrder = await prisma.$transaction(async tx => {
    if (classroom.pin_order != null) {
      await tx.classroom.update({
        where: { id: classroom.id },
        data: { pin_order: null },
      });
      return null;
    }
    // Scope: per git_org_id (simpler than per-user across all memberships).
    const agg = await tx.classroom.aggregate({
      _max: { pin_order: true },
      where: { git_org_id: classroom.git_org_id },
    });
    const next = (agg._max.pin_order ?? 0) + 1;
    await tx.classroom.update({
      where: { id: classroom.id },
      data: { pin_order: next },
    });
    return next;
  });

  return Response.json({ pin_order: newPinOrder });
};
