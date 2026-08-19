/**
 * Set the archive flag on a classroom (idempotent).
 *
 * PATCH /api/classrooms/:id/archive  body: { is_archived: boolean }
 *
 * Only OWNER. Returns `{ is_archived: boolean }`.
 */

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

  // Authorize on the id, not on a slug read back off the record — see the
  // sibling status route: binding to the id is what makes the classroom that was
  // authorized and the row updated below provably the same one.
  await assertClassroomAccess({
    request,
    classroomId,
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
