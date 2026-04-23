import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

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
}): Promise<any> => {
  return getPrisma().regradeRequest.create({
    data: {
      classroom_id,
      repository_assignment_id,
      student_id,
      student_comment,
      previous_grade,
    },
  });
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
