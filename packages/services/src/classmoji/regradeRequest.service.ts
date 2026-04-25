import getPrisma from '@classmoji/database';
import type { Prisma, RegradeRequest } from '@prisma/client';
import * as notificationService from './notification.service.ts';

export const create = async ({
  classroom_id,
  repository_assignment_id,
  student_id,
  student_comment,
  previous_grade,
}: {
  classroom_id: string;
  repository_assignment_id: string;
  student_id: string;
  student_comment?: string | null;
  previous_grade?: string[];
}): Promise<RegradeRequest> => {
  const request = await getPrisma().regradeRequest.create({
    data: {
      classroom_id,
      repository_assignment_id,
      student_id,
      student_comment,
      previous_grade,
    },
  });

  await notificationService.runSafely('regrade request notification', async () => {
    const graders = await getPrisma().repositoryAssignmentGrader.findMany({
      where: { repository_assignment_id },
      select: { grader_id: true },
    });
    const graderIds = graders.map(g => g.grader_id);
    if (graderIds.length > 0) {
      const repoAssignment = await getPrisma().repositoryAssignment.findUnique({
        where: { id: repository_assignment_id },
        select: {
          assignment: { select: { title: true } },
          repository: { select: { name: true } },
        },
      });
      await notificationService.createNotifications({
        type: 'TA_REGRADE_ASSIGNED',
        classroomId: classroom_id,
        recipientUserIds: graderIds,
        resourceType: 'regrade_request',
        resourceId: request.id,
        title: `Regrade request: ${repoAssignment?.assignment.title ?? 'Assignment'} - ${repoAssignment?.repository.name ?? ''}`,
      });
    }
  });

  return request;
};

export const findMany = async (query: Prisma.RegradeRequestWhereInput) => {
  return getPrisma().regradeRequest.findMany({
    where: query,
    include: {
      repository_assignment: {
        include: {
          assignment: true,
          repository: true,
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
