import prisma from '@classmoji/database';

export const create = async payload => {
  const { providerId, provider, name, slug, avatarUrl, privacy, classroomId, tag } = payload;
  return prisma.team.create({
    data: {
      provider_id: providerId ? String(providerId) : null,
      provider: provider || null,
      name: name,
      slug: slug,
      tag: tag,
      classroom_id: classroomId,
      is_visible: privacy !== 'secret',
    },
  });
};

export const deleteBySlug = async (classroomId, slug) => {
  return prisma.team.delete({
    where: {
      classroom_id_slug: {
        slug: slug,
        classroom_id: classroomId,
      },
    },
  });
};

export const findByClassroomId = async classroomId => {
  return prisma.team.findMany({
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

export const findBySlugAndClassroomId = async (slug, classroomId) => {
  return prisma.team.findUnique({
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

export const findById = async teamId => {
  return prisma.team.findUnique({
    where: { id: teamId },
    include: {
      memberships: true,
      tags: true,
    },
  });
};

export const findByTagId = async (classroomId, tagId) => {
  return prisma.team.findMany({
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

export const findUserTeamByTag = async (classroomId, tagId, userId) => {
  return prisma.team.findFirst({
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

export const createWithMembershipAndTag = async payload => {
  const { name, slug, classroomId, providerId, userId, tagId } = payload;
  return prisma.team.create({
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
