import prisma from '@classmoji/database';

export const create = async (teamId: string, tagId: string) => {
  return prisma!.teamTag.create({
    data: {
      team_id: teamId,
      tag_id: tagId,
    },
  });
};

const deleteTeamTag = async (id: string) => {
  return prisma!.teamTag.delete({
    where: { id },
  });
};
export { deleteTeamTag as delete };
