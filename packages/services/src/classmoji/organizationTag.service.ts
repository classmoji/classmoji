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
