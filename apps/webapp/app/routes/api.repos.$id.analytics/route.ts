import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * GET /api/repos/:id/analytics
 *
 * `:id` is the RepositoryAssignment.id. Returns:
 * `{ snapshot, deadline, repositoryId, students }` where `snapshot` is the
 * persisted `RepoAnalyticsSnapshot` (or `null` if none yet), `students`
 * is the classroom's STUDENT roster formatted for `ContributorBreakdown`.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const repoAssignmentId = params.id!;

  const repoAssignment = await getPrisma().repositoryAssignment.findUnique({
    where: { id: repoAssignmentId },
    include: {
      assignment: true,
      repository: {
        select: { id: true, classroom_id: true, classroom: { select: { slug: true } } },
      },
      analytics_snapshot: true,
    },
  });

  if (!repoAssignment) {
    return new Response('Repository assignment not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  await assertClassroomAccess({
    request,
    classroomSlug: repoAssignment.repository.classroom.slug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'REPOSITORY_ASSIGNMENT',
    attemptedAction: 'view_submission_analytics',
    metadata: { repository_assignment_id: repoAssignmentId },
  });

  const studentMemberships = await ClassmojiService.classroomMembership.findStudents(
    repoAssignment.repository.classroom_id,
  );
  const students = studentMemberships.map((m) => ({
    id: m.user.id,
    name: m.user.name ?? m.user.login ?? 'Unknown',
    login: m.user.login ?? null,
  }));

  return Response.json({
    snapshot: repoAssignment.analytics_snapshot,
    deadline: repoAssignment.assignment.student_deadline?.toISOString() ?? null,
    repositoryId: repoAssignment.repository.id,
    students,
  });
};
