/**
 * Set the archive flag on a classroom (idempotent).
 *
 * PATCH /api/classrooms/:id/archive  body: { is_archived: boolean }
 *
 * Only OWNER. Returns `{ is_archived: boolean }`.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);
  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { is_archived?: boolean };
  if (typeof body.is_archived !== 'boolean') {
    return new Response('Invalid body', { status: 400 });
  }

  const prisma = getPrisma();

  const ownerMembership = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId, role: 'OWNER' },
    select: { id: true },
  });
  if (!ownerMembership) {
    return new Response('Forbidden', { status: 403 });
  }

  const updated = await prisma.classroom.update({
    where: { id: classroomId },
    data: { is_archived: body.is_archived },
    select: { is_archived: true },
  });

  return Response.json(updated);
};
