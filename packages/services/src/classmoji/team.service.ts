import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { sortNaturallyBy, withLogins } from '@classmoji/utils';
import type { GitProvider, Prisma } from '@prisma/client';

interface TeamCreatePayload {
  providerId?: string | number | null;
  provider?: GitProvider | null;
  name: string;
  slug: string;
  /**
   * Whether students who are not members can see the team. Defaults to false,
   * matching the schema default. This used to be derived from a `privacy`
   * string that every caller hard-coded to 'closed', so the visibility choice
   * offered in the UI never reached the database.
   */
  isVisible?: boolean;
  classroomId: string;
  /**
   * Tags to attach, written in the same create as the team row. Ids must
   * already be checked against the classroom; an unknown id fails the whole
   * create.
   */
  tagIds?: string[];
}

interface TeamCreateWithMembershipAndTagPayload {
  name: string;
  slug: string;
  classroomId: string;
  providerId: string | number;
  userId: string;
  tagId: string;
  /** The team's provider; GitLab teams are subgroups. Default Github. */
  provider?: 'GITHUB' | 'GITLAB';
}

/**
 * Create a team row. The tags are a nested write, so Prisma inserts the row and
 * its TeamTag rows in one transaction: either all of them exist or none do.
 */
export const create = async (payload: TeamCreatePayload) => {
  const { providerId, provider, name, slug, isVisible = false, classroomId, tagIds = [] } = payload;
  const data: Prisma.TeamUncheckedCreateInput = {
    provider_id: providerId ? String(providerId) : null,
    provider: provider || null,
    name: name,
    slug: slug,
    classroom_id: classroomId,
    is_visible: isVisible,
    tags: { create: tagIds.map(tag_id => ({ tag_id })) },
  };
  return getPrisma().team.create({ data });
};

export const deleteBySlug = async (classroomId: string, slug: string) => {
  return getPrisma().team.delete({
    where: {
      classroom_id_slug: {
        slug: slug,
        classroom_id: classroomId,
      },
    },
  });
};

export const findByClassroomId = async (classroomId: string) => {
  const teams = await getPrisma().team.findMany({
    where: {
      classroom_id: classroomId,
    },
    include: {
      tags: {
        include: {
          tag: true,
        },
      },
      memberships: {
        include: {
          user: { include: GIT_IDENTITY },
        },
      },
    },
  });

  // Same human order as the repository tables, so a team sits in the same place
  // on both screens.
  return withLogins(teams.sort(sortNaturallyBy(team => team.name)));
};

export const findBySlugAndClassroomId = async (slug: string, classroomId: string) => {
  return withLogins(
    await getPrisma().team.findUnique({
      where: {
        classroom_id_slug: {
          slug: slug,
          classroom_id: classroomId,
        },
      },
      include: {
        tags: {
          include: {
            tag: true,
          },
        },
        memberships: {
          include: {
            user: { include: GIT_IDENTITY },
          },
        },
      },
    })
  );
};

export const findById = async (teamId: string) => {
  return getPrisma().team.findUnique({
    where: { id: teamId },
    include: {
      memberships: true,
      tags: true,
    },
  });
};

export const findByIdWithRepositories = async (teamId: string) => {
  return getPrisma().team.findUnique({
    where: { id: teamId },
    include: {
      git_repos: true,
    },
  });
};

interface RepoRename {
  id: string;
  name: string;
}

export const renameAndRepos = async (payload: {
  teamId: string;
  newName: string;
  newSlug: string;
  repoRenames: RepoRename[];
}) => {
  const { teamId, newName, newSlug, repoRenames } = payload;
  const prisma = getPrisma();
  return prisma.$transaction([
    prisma.team.update({
      where: { id: teamId },
      data: { name: newName, slug: newSlug },
    }),
    ...repoRenames.map(r =>
      prisma.gitRepo.update({
        where: { id: r.id },
        data: { name: r.name },
      })
    ),
  ]);
};

export const findByTagId = async (classroomId: string, tagId: string) => {
  return withLogins(
    await getPrisma().team.findMany({
      where: {
        classroom_id: classroomId,
        tags: { some: { tag_id: tagId } },
      },
      include: {
        memberships: {
          include: {
            user: {
              select: { id: true, name: true, image: true, ...GIT_IDENTITY },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  );
};

export const findUserTeamByTag = async (classroomId: string, tagId: string, userId: string) => {
  return withLogins(
    await getPrisma().team.findFirst({
      where: {
        classroom_id: classroomId,
        tags: { some: { tag_id: tagId } },
        memberships: { some: { user_id: userId } },
      },
      include: {
        memberships: {
          include: {
            user: {
              select: { id: true, name: true, image: true, ...GIT_IDENTITY },
            },
          },
        },
      },
    })
  );
};

export const createWithMembershipAndTag = async (
  payload: TeamCreateWithMembershipAndTagPayload
) => {
  const { name, slug, classroomId, providerId, userId, tagId, provider = 'GITHUB' } = payload;
  return getPrisma().team.create({
    data: {
      name,
      slug,
      classroom_id: classroomId,
      provider,
      provider_id: String(providerId),
      is_visible: true,
      memberships: {
        create: { user_id: userId },
      },
      tags: {
        create: { tag_id: tagId },
      },
    },
  });
};
