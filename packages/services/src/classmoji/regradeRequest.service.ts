import getPrisma from '@classmoji/database';
import type { Prisma, RegradeRequest } from '@prisma/client';
import * as notificationService from './notification.service.ts';

export const create = async ({
  classroom_id,
  git_repo_assignment_id,
  student_id,
  student_comment,
  previous_grade,
}: {
  classroom_id: string;
  git_repo_assignment_id: string;
  student_id: string;
  student_comment?: string | null;
  previous_grade?: string[];
}): Promise<RegradeRequest> => {
  const request = await getPrisma().regradeRequest.create({
    data: {
      classroom_id,
      git_repo_assignment_id,
      student_id,
      student_comment,
      previous_grade,
    },
  });

  await notificationService.runSafely('regrade request notification', async () => {
    const graders = await getPrisma().gitRepoAssignmentGrader.findMany({
      where: { git_repo_assignment_id },
      select: { grader_id: true },
    });
    const graderIds = graders.map(g => g.grader_id);
    if (graderIds.length > 0) {
      const repoAssignment = await getPrisma().gitRepoAssignment.findUnique({
        where: { id: git_repo_assignment_id },
        select: {
          assignment: { select: { title: true } },
          git_repo: { select: { name: true } },
        },
      });
      await notificationService.createNotifications({
        type: 'TA_REGRADE_ASSIGNED',
        classroomId: classroom_id,
        recipientUserIds: graderIds,
        resourceType: 'regrade_request',
        resourceId: request.id,
        title: `Regrade request: ${repoAssignment?.assignment.title ?? 'Assignment'} - ${repoAssignment?.git_repo.name ?? ''}`,
      });
    }
  });

  return request;
};

export const findMany = async (query: Prisma.RegradeRequestWhereInput) => {
  return getPrisma().regradeRequest.findMany({
    where: query,
    include: {
      git_repo_assignment: {
        include: {
          assignment: true,
          git_repo: true,
          graders: {
            include: {
              grader: true,
            },
          },
          grades: {
            include: {
              token_transaction: true,
              grader: true,
            },
          },
        },
      },
      student: {
        select: {
          login: true,
          name: true,
          id: true,
          email: true,
          image: true,
          provider_id: true,
          _count: {
            select: {
              regrade_requests: true,
            },
          },
        },
      },
    },
    orderBy: {
      created_at: 'desc',
    },
  });
};

/**
 * Find the open (IN_REVIEW) regrade request for a GitRepoAssignment, if any.
 * Returns the most recent one when multiple exist.
 */
export const findOpenByAssignmentId = async (gitRepoAssignmentId: string) => {
  return getPrisma().regradeRequest.findFirst({
    where: {
      git_repo_assignment_id: gitRepoAssignmentId,
      status: 'IN_REVIEW',
    },
    orderBy: {
      created_at: 'desc',
    },
  });
};

export const update = async ({
  id,
  data,
}: {
  id: string;
  data: Prisma.RegradeRequestUpdateInput;
}) => {
  return getPrisma().regradeRequest.update({
    where: { id },
    data,
  });
};
