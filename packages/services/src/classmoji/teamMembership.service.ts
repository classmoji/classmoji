import getPrisma from '@classmoji/database';

export const addMemberToTeam = async (teamId: string, userId: string) => {
  return getPrisma().teamMembership.upsert({
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

/**
 * Idempotent by design: deleteMany reports `{ count: 0 }` for a membership that
 * is already gone, where the previous `delete` threw P2025 and turned a
 * repeated (or raced) removal into a 500.
 */
export const removeMemberFromTeam = async (teamId: string, userId: string) => {
  return getPrisma().teamMembership.deleteMany({
    where: {
      team_id: teamId,
      user_id: userId,
    },
  });
};

export const findTeamsByUserId = async (userId: string) => {
  return getPrisma().teamMembership.findMany({
    where: {
      user_id: userId,
    },
  });
};
