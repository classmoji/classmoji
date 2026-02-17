import prisma from '@classmoji/database';

export const addMemberToTeam = async (teamId, userId) => {
  return prisma.teamMembership.upsert({
    where: {
      team_id_user_id: {
        team_id: teamId,
        user_id: userId,
      },
    },
    create: {
      team_id: teamId,
      user_id: userId,
    },
    update: {},
  });
};

export const removeMemberFromTeam = async (teamId, userId) => {
  return prisma.teamMembership.delete({
    where: {
      team_id_user_id: {
        team_id: teamId,
        user_id: userId,
      },
    },
  });
};

export const findTeamsByUserId = async userId => {
  return prisma.teamMembership.findMany({
    where: {
      user_id: userId,
    },
  });
};
