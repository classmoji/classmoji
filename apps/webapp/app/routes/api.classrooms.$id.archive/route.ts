/**
 * Set the archive flag on a classroom (idempotent).
 *
 * PATCH /api/classrooms/:id/archive  body: { is_archived: boolean }
 *
 * Only OWNER. Returns `{ is_archived: boolean }`.
 */

import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { is_archived?: boolean };
  if (typeof body.is_archived !== 'boolean') {
    return new Response('Invalid body', { status: 400 });
  }

  const classroom = await ClassmojiService.classroom.findById(classroomId);
  if (!classroom) {
    return new Response('Classroom not found', { status: 404 });
  }

  await assertClassroomAccess({
    request,
    classroomSlug: classroom.slug,
    allowedRoles: ['OWNER'],
    resourceType: 'CLASSROOM',
    attemptedAction: body.is_archived ? 'archive_classroom' : 'unarchive_classroom',
    metadata: { classroom_id: classroomId },
  });

  const prisma = getPrisma();
  const updated = await prisma.classroom.update({
    where: { id: classroomId },
    data: { is_archived: body.is_archived },
    select: { is_archived: true },
  });

  return Response.json(updated);
};
