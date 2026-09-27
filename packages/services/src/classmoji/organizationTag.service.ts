import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

export const create = async (classroomId: string, name: string) => {
  return getPrisma().tag.create({
    data: {
      classroom_id: classroomId,
      name,
    },
  });
};

const deleteTag = async (tagId: string) => {
  return getPrisma().tag.delete({
    where: { id: tagId },
  });
};
export { deleteTag as delete };

export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().tag.findMany({
    where: { classroom_id: classroomId },
  });
};

/**
 * Every tag in the classroom with how many teams carry it and how many
 * repositories point at it, ordered by name.
 */
export const findByClassroomIdWithCounts = async (classroomId: string) => {
  return getPrisma().tag.findMany({
    where: { classroom_id: classroomId },
    select: {
      id: true,
      name: true,
      _count: { select: { teams: true, repositories: true } },
    },
    orderBy: { name: 'asc' },
  });
};

export const findByClassroomIdAndName = async (classroomId: string, name: string) => {
  return getPrisma().tag.findUnique({
    where: {
      classroom_id_name: {
        classroom_id: classroomId,
        name,
      },
    },
  });
};

export const upsert = async (classroomId: string, name: string) => {
  return getPrisma().tag.upsert({
    where: {
      classroom_id_name: {
        classroom_id: classroomId,
        name,
      },
    },
    create: {
      classroom_id: classroomId,
      name,
    },
    update: {},
  });
};

/**
 * `upsert` that also says whether it created the row — the same end state
 * (the tag named `name` exists in the classroom and is returned), plus
 * `created`.
 *
 * Race-safe by construction: it tries the INSERT and treats a unique violation
 * as "already existed", so of two concurrent calls for one name exactly one
 * reports `created: true`. A lookup-then-upsert would let both claim it. The
 * only unique index on Tag besides its uuid key is (classroom_id, name), and a
 * violation is only trusted once the row can be read back; otherwise the
 * original error is rethrown.
 *
 * Names are compared exactly (case-sensitive), as the unique index and the web
 * tag screens do: 'Frontend' and 'frontend' are two tags.
 */
export const findOrCreate = async (
  classroomId: string,
  name: string
): Promise<{ tag: { id: string; name: string }; created: boolean }> => {
  try {
    const tag = await getPrisma().tag.create({
      data: { classroom_id: classroomId, name },
    });
    return { tag, created: true };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
    const existing = await findByClassroomIdAndName(classroomId, name);
    if (!existing) throw error;
    return { tag: existing, created: false };
  }
};

export const findTeamsByTag = async (tagId: string) => {
  const tag = await getPrisma().tag.findUnique({
    where: { id: tagId },
    include: {
      teams: {
        include: {
          team: true,
        },
      },
    },
  });

  if (!tag) return [];

  return tag.teams.map(
    ({ team }: { team: Prisma.TeamTagGetPayload<{ include: { team: true } }>['team'] }) => team
  );
};
