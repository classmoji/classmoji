import prisma from '@classmoji/database';

export const create = async (classroomId, name) => {
  return prisma.tag.create({
    data: {
      classroom_id: classroomId,
      name,
    },
  });
};

const deleteTag = async tagId => {
  return prisma.tag.delete({
    where: { id: tagId },
  });
};
export { deleteTag as delete };

export const findByClassroomId = async classroomId => {
  return prisma.tag.findMany({
    where: { classroom_id: classroomId },
  });
};

export const findByClassroomIdAndName = async (classroomId, name) => {
  return prisma.tag.findUnique({
    where: {
      classroom_id_name: {
        classroom_id: classroomId,
        name,
      },
    },
  });
};

export const upsert = async (classroomId, name) => {
  return prisma.tag.upsert({
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

export const findTeamsByTag = async tagId => {
  const { teams } = await prisma.tag.findUnique({
    where: { id: tagId },
    include: {
      teams: {
        include: {
          team: true,
        },
      },
    },
  });

  return teams.map(({ team }) => team);
};
