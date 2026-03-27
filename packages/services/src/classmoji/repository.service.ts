import getPrisma from '@classmoji/database';
import type { GitProvider, Prisma } from '@prisma/client';

interface RepositoryCreatePayload {
  moduleId: string;
  classroom: { id: string; git_organization: { provider: GitProvider | string } };
  repoName: string;
  student?: { id: string } | null;
  team?: { id: string } | null;
  providerId: string;
}

export const create = async (payload: RepositoryCreatePayload) => {
  const { moduleId, classroom, repoName, student, team, providerId } = payload;

  return getPrisma().repository.create({
    data: {
      name: repoName,
      classroom_id: classroom.id,
      module_id: moduleId,
      team_id: team?.id,
      student_id: student?.id,
      provider: classroom.git_organization.provider as GitProvider,
      provider_id: providerId,
    },
  });
};

export const findByModule = async (classroomSlug: string, moduleId: string) => {
  const repos = await getPrisma().repository.findMany({
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

export const findMany = async (query: Prisma.RepositoryWhereInput) => {
  return getPrisma().repository.findMany({
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

export const findByName = async (classroomSlug: string, repoName: string) => {
  return getPrisma().repository.findFirst({
    where: {
      classroom: { slug: classroomSlug },
      name: repoName,
    },
  });
};

export const find = async (query: Prisma.RepositoryWhereInput) => {
  return getPrisma().repository.findFirst({
    where: {
      ...query,
    },
  });
};

export const findByStudent = async (moduleId: string, userId: string) => {
  return getPrisma().repository.findFirst({
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

export const deleteById = async (repoId: string) => {
  return getPrisma().repository.delete({
    where: {
      id: repoId,
    },
  });
};

export const update = async (repoId: string, data: Prisma.RepositoryUpdateInput) => {
  return getPrisma().repository.update({
    where: {
      id: repoId,
    },
    data,
  });
};
