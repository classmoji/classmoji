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

  // Resolve the owning classroom so we can run auth against its slug.
  const repoAssignment =
    await ClassmojiService.gitRepoAssignment.findById(repositoryAssignmentId);

  if (!repoAssignment) {
    return new Response('Repository assignment not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const classroom = await ClassmojiService.classroom.findById(
    repoAssignment.git_repo.classroom_id
  );

  if (!classroom) {
    return new Response('Classroom not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const { classroom: accessClassroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classroom.slug,
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
