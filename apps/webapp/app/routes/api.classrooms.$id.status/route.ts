/**
 * Set the status on a classroom.
 *
 * PATCH /api/classrooms/:id/status  body: { status: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED' }
 *
 * Only OWNER. Returns `{ status }`. Making a class ACTIVE again can be refused
 * by the Free plan's one-active-class rule: 403 `{ error }`.
 */

import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import { lifecycleRefusal } from '~/utils/classroomLifecycle.server';
import type { Route } from './+types/route';

const STATUSES = ['ACTIVE', 'LOCKED', 'UNPUBLISHED'] as const;
type Status = (typeof STATUSES)[number];

export const action = async ({ request, params }: Route.ActionArgs) => {
  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const classroomId = params.id;
  if (!classroomId) {
    return new Response('Missing classroom id', { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { status?: Status };
  if (!body.status || !STATUSES.includes(body.status)) {
    return new Response('Invalid status', { status: 400 });
  }

  // Authorize on the id, not on a slug read back off the record: resolving the
  // classroom and then authorizing against its slug sends the auth layer through
  // a second lookup, and nothing ties the classroom it lands on to the row
  // updated below. `classroomId` makes them the same row by construction. It
  // also 404s an unknown id only after the session check, so ids stay
  // unenumerable to anonymous callers.
  const { userId } = await assertClassroomAccess({
    request,
    classroomId,
    allowedRoles: ['OWNER'],
    resourceType: 'CLASSROOM',
    attemptedAction: 'change_classroom_status',
    metadata: { classroom_id: classroomId, new_status: body.status },
  });

  try {
    const updated = await ClassmojiService.classroomLifecycle.setLifecycle({
      classroomId,
      status: body.status,
      actorUserId: userId,
      tool: 'web:classroom.status',
    });
    return Response.json({ status: updated.status });
  } catch (error) {
    const refusal = lifecycleRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
};
