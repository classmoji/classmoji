/**
 * Toggle archive (is_active) on a classroom.
 *
 * POST /api/classrooms/:id/archive
 *
 * Only OWNER can archive or unarchive a classroom. Returns `{ is_active: boolean }`.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
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

  const prisma = getPrisma();

  const ownerMembership = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId, role: 'OWNER' },
    select: { id: true },
  });
  if (!ownerMembership) {
    return new Response('Forbidden', { status: 403 });
  }

  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    select: { is_active: true },
  });
  if (!classroom) {
    return new Response('Not Found', { status: 404 });
  }

  const updated = await prisma.classroom.update({
    where: { id: classroomId },
    data: { is_active: !classroom.is_active },
    select: { is_active: true },
  });

  return Response.json({ is_active: updated.is_active });
};
