import prisma from '@classmoji/database';

export const create = async (teamId, tagId) => {
  return prisma.teamTag.create({
    data: {
      team_id: teamId,
      tag_id: tagId,
    },
  });
};

const deleteTeamTag = async id => {
  return prisma.teamTag.delete({
    where: { id },
  });
};
export { deleteTeamTag as delete };
