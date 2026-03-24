import prisma from '@classmoji/database';

export const addMemberToTeam = async (teamId: string, userId: string) => {
  return prisma!.teamMembership.upsert({
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

export const removeMemberFromTeam = async (teamId: string, userId: string) => {
  return prisma!.teamMembership.delete({
    where: {
      team_id_user_id: {
        team_id: teamId,
        user_id: userId,
      },
    },
  });
};

export const findTeamsByUserId = async (userId: string) => {
  return prisma!.teamMembership.findMany({
    where: {
      user_id: userId,
    },
  });
};
