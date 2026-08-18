import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * POST /api/repos/:id/refresh
 *
 * Enqueue a `refresh-repo-analytics` run for the given git_repo_assignment_id.
 * Scoped to the owning classroom — only OWNER/TEACHER/ASSISTANT may trigger.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Content-Type': 'text/plain', Allow: 'POST' },
    });
  }

  const repositoryAssignmentId = params.id!;

  // Load the assignment so its OWN classroom id can authorize the refresh.
  const repoAssignment =
    await ClassmojiService.gitRepoAssignment.findById(repositoryAssignmentId);

  if (!repoAssignment) {
    return new Response('Repository assignment not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Authorize on the id, not on a slug read back off a classroom record:
  // resolving the classroom and then handing its slug to the auth layer sent it
  // through a second lookup, so nothing tied the authorized classroom to the
  // assignment refreshed below.
  const { classroom: accessClassroom, membership } = await assertClassroomAccess({
    request,
    classroomId: repoAssignment.git_repo.classroom_id,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'REPOSITORY_ASSIGNMENT',
    attemptedAction: 'refresh_repo_analytics',
    metadata: { git_repo_assignment_id: repositoryAssignmentId },
  });
  assertClassroomMutationAllowed({ status: accessClassroom.status, role: membership!.role });

  const handle = await tasks.trigger('refresh-repo-analytics', {
    repositoryAssignmentId,
  });

  return Response.json({ enqueued: true, job_id: handle.id });
};
