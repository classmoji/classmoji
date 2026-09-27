import getPrisma from '@classmoji/database';
import { sortNaturallyBy } from '@classmoji/utils';
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

/**
 * Note a push the provider reported for this repo. Never moves backwards, so
 * a late-delivered older webhook cannot hide a newer push.
 */
export const recordPushTime = async (gitRepoId: string, pushedAt: Date) => {
  return getPrisma().gitRepo.updateMany({
    where: { id: gitRepoId, OR: [{ last_push_at: null }, { last_push_at: { lt: pushedAt } }] },
    data: { last_push_at: pushedAt },
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
      // Members ride along so a team row can name who is on it.
      team: { include: { memberships: { include: { user: true } } } },
      repository: true,
      assignments: {
        include: {
          token_transactions: true,
          assignment: true,
          // Latest commit seen per submission row; the page shows the newest
          // across the repo as "last push".
          analytics_snapshot: {
            select: { total_commits: true, last_commit_at: true, fetched_at: true, commits: true },
          },
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

  // Sorted in JS, not the query: Postgres would put `group-a10` above
  // `group-a2`. Keyed on the column the reader scans — team for GROUP, student
  // for INDIVIDUAL.
  return repos.sort(
    sortNaturallyBy(
      repo => repo.team?.name ?? repo.student?.name ?? repo.student?.login ?? repo.name
    )
  );
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

/** A usable id for a scoped `where`: a non-empty string, nothing else. */
const isScopedId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Find one git repo of a classroom, optionally narrowed to one Repository.
 *
 * Returns null — without querying — when an id is not a non-empty string.
 * Prisma drops an `undefined` value from a `where` rather than rejecting it, and
 * an id field also accepts a filter object, so an unchecked value would turn
 * this into "any git repo in the classroom".
 */
export const findByIdInClassroom = async (
  id: unknown,
  classroomId: string,
  options: { repositoryId?: string } = {}
) => {
  if (!isScopedId(id) || !isScopedId(classroomId)) return null;
  if (options.repositoryId !== undefined && !isScopedId(options.repositoryId)) return null;

  return getPrisma().gitRepo.findFirst({
    where: {
      id,
      classroom_id: classroomId,
      ...(options.repositoryId ? { repository_id: options.repositoryId } : {}),
    },
  });
};

/**
 * Delete one git repo row of a classroom.
 *
 * The classroom id is part of the write itself (`deleteMany` accepts the
 * non-unique pair), so the row is only removed when it belongs to that
 * classroom. `id` is the primary key, so anything other than one deleted row
 * means it did not, and nothing was written — which throws rather than passing
 * as a silent no-op. Deleting the row cascades to its submissions and grades.
 */
export const deleteInClassroom = async (id: string, classroomId: string) => {
  if (!isScopedId(id)) throw new Error('Invalid git repo id');
  if (!isScopedId(classroomId)) throw new Error('Invalid classroom id');

  const { count } = await getPrisma().gitRepo.deleteMany({
    where: { id, classroom_id: classroomId },
  });
  if (count !== 1) throw new Error('Git repo not found in classroom');
  return { id };
};

export const update = async (repoId: string, data: Prisma.GitRepoUpdateInput) => {
  return getPrisma().gitRepo.update({
    where: {
      id: repoId,
    },
    data,
  });
};
