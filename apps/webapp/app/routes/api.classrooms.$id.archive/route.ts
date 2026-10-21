/**
 * Set the archive flag on a classroom (idempotent).
 *
 * PATCH /api/classrooms/:id/archive  body: { is_archived: boolean, lock?: boolean }
 *
 * Only OWNER. Returns `{ is_archived, status }`.
 *
 * `lock: true` is the full archive (LOCKED + archived), the one that frees the
 * class's Free-plan slot; un-archiving with it makes the class ACTIVE again,
 * which the one-active-class rule may refuse (403 `{ error }`). Without it only
 * the flag changes, as before.
 */

import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import { lifecycleRefusal } from '~/utils/classroomLifecycle.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    is_archived?: boolean;
    lock?: boolean;
  };
  if (typeof body.is_archived !== 'boolean') {
    return new Response('Invalid body', { status: 400 });
  }

  // Authorize on the id, not on a slug read back off the record — see the
  // sibling status route: binding to the id is what makes the classroom that was
  // authorized and the row updated below provably the same one.
  const { userId } = await assertClassroomAccess({
    request,
    classroomId,
    allowedRoles: ['OWNER'],
    resourceType: 'CLASSROOM',
    attemptedAction: body.is_archived ? 'archive_classroom' : 'unarchive_classroom',
    metadata: { classroom_id: classroomId },
  });

  const lifecycle = ClassmojiService.classroomLifecycle;
  const args = { classroomId, actorUserId: userId, tool: 'web:classroom.archive' };
  try {
    const updated =
      body.lock === true
        ? await (body.is_archived ? lifecycle.archive(args) : lifecycle.unarchive(args))
        : await lifecycle.setLifecycle({ ...args, isArchived: body.is_archived });
    return Response.json(updated);
  } catch (error) {
    const refusal = lifecycleRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
};
