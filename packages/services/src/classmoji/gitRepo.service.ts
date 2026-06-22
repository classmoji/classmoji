import getPrisma from '@classmoji/database';
import type { GitProvider, Prisma } from '@prisma/client';

interface RepositoryCreatePayload {
  repositoryId: string;
  classroom: { id: string; git_organization: { provider: GitProvider | string } };
  repoName: string;
  student?: { id: string } | null;
  team?: { id: string } | null;
  providerId: string;
}

export const create = async (payload: RepositoryCreatePayload) => {
  const { repositoryId, classroom, repoName, student, team, providerId } = payload;
  const provider = classroom.git_organization.provider as GitProvider;

  // Upsert (not create) keyed on the @@unique([provider, provider_id]) constraint so
  // re-runs heal the row instead of crashing. The GitHub side of repo creation is already
  // idempotent (existing repos are detected and reused / Sync routes them back through), so
  // a repo can exist before this row does — e.g. a retry, a Sync, or a run cancelled after
  // the repo was created but before this insert. A plain create() collides in those cases
  // with "Unique constraint failed on the fields: (provider, provider_id)".
  const mutableFields = {
    name: repoName,
    classroom_id: classroom.id,
    repository_id: repositoryId,
    team_id: team?.id ?? null,
    student_id: student?.id ?? null,
  };

  return getPrisma().gitRepo.upsert({
    where: { provider_provider_id: { provider, provider_id: providerId } },
    create: { ...mutableFields, provider, provider_id: providerId },
    update: mutableFields,
  });
};

export const findByRepository = async (classroomSlug: string, repositoryId: string) => {
  const repos = await getPrisma().gitRepo.findMany({
    where: {
      classroom: { slug: classroomSlug },
      repository_id: repositoryId,
    },
    include: {
      student: true,
      team: true,
      repository: true,
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

export const findMany = async (query: Prisma.GitRepoWhereInput) => {
  return getPrisma().gitRepo.findMany({
    where: query,
    include: {
      repository: true,
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
  return getPrisma().gitRepo.findFirst({
    where: {
      classroom: { slug: classroomSlug },
      name: repoName,
    },
  });
};

export const find = async (query: Prisma.GitRepoWhereInput) => {
  return getPrisma().gitRepo.findFirst({
    where: {
      ...query,
    },
  });
};

export const findByStudent = async (repositoryId: string, userId: string) => {
  return getPrisma().gitRepo.findFirst({
    where: {
      repository_id: repositoryId,
      student_id: userId,
    },
    include: {
      repository: true,
      student: true,
      classroom: true,
    },
  });
};

export const deleteById = async (repoId: string) => {
  return getPrisma().gitRepo.delete({
    where: {
      id: repoId,
    },
  });
};

export const update = async (repoId: string, data: Prisma.GitRepoUpdateInput) => {
  return getPrisma().gitRepo.update({
    where: {
      id: repoId,
    },
    data,
  });
};
