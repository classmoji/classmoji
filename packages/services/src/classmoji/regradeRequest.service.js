import prisma from '@classmoji/database';

export const create = async ({
  classroom_id,
  repository_assignment_id,
  student_id,
  student_comment,
  previous_grade,
}) => {
  return prisma.regradeRequest.create({
    data: {
      classroom_id,
      repository_assignment_id,
      student_id,
      student_comment,
      previous_grade,
    },
  });
};

export const findMany = async query => {
  return prisma.regradeRequest.findMany({
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
          avatar_url: true,
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

export const update = async ({ id, data }) => {
  return prisma.regradeRequest.update({
    where: { id },
    data,
  });
};
