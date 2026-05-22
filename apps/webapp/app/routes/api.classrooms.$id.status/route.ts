/**
 * Set the status on a classroom.
 *
 * PATCH /api/classrooms/:id/status  body: { status: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED' }
 *
 * Only OWNER. Returns `{ status }`.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

const STATUSES = ['ACTIVE', 'LOCKED', 'UNPUBLISHED'] as const;
type Status = (typeof STATUSES)[number];

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);
  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { status?: Status };
  if (!body.status || !STATUSES.includes(body.status)) {
    return new Response('Invalid status', { status: 400 });
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
    data: { status: body.status },
    select: { status: true },
  });

  return Response.json(updated);
};
