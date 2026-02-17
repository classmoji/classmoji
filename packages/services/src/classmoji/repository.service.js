import prisma from '@classmoji/database';

export const create = async payload => {
  const { moduleId, classroom, repoName, student, team, providerId } = payload;

  return prisma.repository.create({
    data: {
      name: repoName,
      classroom_id: classroom.id,
      module_id: moduleId,
      team_id: team?.id,
      student_id: student?.id,
      provider: classroom.git_organization.provider,
      provider_id: providerId,
    },
  });
};

export const findByModule = async (classroomSlug, moduleId) => {
  const repos = await prisma.repository.findMany({
    where: {
      classroom: { slug: classroomSlug },
      module_id: moduleId,
    },
    include: {
      student: true,
      team: true,
      module: true,
      assignments: {
        include: {
          token_transactions: true,
          assignment: true,
          grades: {
            include: {
              token_transaction: true,
              grader: true,
            },
          },
          graders: {
            include: {
              grader: true,
            },
          },
        },
      },
    },
  });

  return repos;
};

export const findMany = async query => {
  return prisma.repository.findMany({
    where: query,
    include: {
      module: true,
      student: true,
      assignments: {
        include: {
          assignment: true,
          token_transactions: true,
          grades: {
            include: {
              token_transaction: true,
            },
          },
          graders: {
            include: {
              grader: true,
            },
          },
        },
      },
    },
  });
};

export const findByName = async (classroomSlug, repoName) => {
  return prisma.repository.findFirst({
    where: {
      classroom: { slug: classroomSlug },
      name: repoName,
    },
  });
};

export const find = async query => {
  return prisma.repository.findFirst({
    where: {
      ...query,
    },
  });
};

export const findByStudent = async (moduleId, userId) => {
  return prisma.repository.findFirst({
    where: {
      module_id: moduleId,
      student_id: userId,
    },
    include: {
      module: true,
      student: true,
      classroom: true,
    },
  });
};

export const deleteById = async repoId => {
  return prisma.repository.delete({
    where: {
      id: repoId,
    },
  });
};

export const update = async (repoId, data) => {
  return prisma.repository.update({
    where: {
      id: repoId,
    },
    data,
  });
};
