import getPrisma from '@classmoji/database';
import type { GitProvider, Prisma } from '@prisma/client';

interface TeamCreatePayload {
  providerId?: string | number | null;
  provider?: GitProvider | null;
  name: string;
  slug: string;
  avatarUrl?: string | null;
  privacy?: string | null;
  classroomId: string;
  tag?: unknown;
}

interface TeamCreateWithMembershipAndTagPayload {
  name: string;
  slug: string;
  classroomId: string;
  providerId: string | number;
  userId: string;
  tagId: string;
}

export const create = async (payload: TeamCreatePayload) => {
  const {
    providerId,
    provider,
    name,
    slug,
    avatarUrl: _avatarUrl,
    privacy,
    classroomId,
    tag,
  } = payload;
  const teamCreateData: unknown = {
    provider_id: providerId ? String(providerId) : null,
    provider: provider || null,
    name: name,
    slug: slug,
    tag: tag,
    classroom_id: classroomId,
    is_visible: privacy !== 'secret',
  };
  // TODO: narrow further once legacy team relation writes are aligned with generated Prisma input types.
  return getPrisma().team.create({
    data: teamCreateData as Prisma.TeamUncheckedCreateInput,
  });
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
  return getPrisma().team.findMany({
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
          user: true,
        },
      },
    },
  });
};

export const findBySlugAndClassroomId = async (slug: string, classroomId: string) => {
  return getPrisma().team.findUnique({
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
          user: true,
        },
      },
    },
  });
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

export const findByTagId = async (classroomId: string, tagId: string) => {
  return getPrisma().team.findMany({
    where: {
      classroom_id: classroomId,
      tags: { some: { tag_id: tagId } },
    },
    include: {
      memberships: {
        include: {
          user: {
            select: { id: true, name: true, login: true, provider_id: true },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
};

export const findUserTeamByTag = async (classroomId: string, tagId: string, userId: string) => {
  return getPrisma().team.findFirst({
    where: {
      classroom_id: classroomId,
      tags: { some: { tag_id: tagId } },
      memberships: { some: { user_id: userId } },
    },
    include: {
      memberships: {
        include: {
          user: {
            select: { id: true, name: true, login: true, provider_id: true },
          },
        },
      },
    },
  });
};

export const createWithMembershipAndTag = async (
  payload: TeamCreateWithMembershipAndTagPayload
) => {
  const { name, slug, classroomId, providerId, userId, tagId } = payload;
  return getPrisma().team.create({
    data: {
      name,
      slug,
      classroom_id: classroomId,
      provider: 'GITHUB',
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
