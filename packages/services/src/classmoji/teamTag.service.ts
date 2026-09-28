import getPrisma from '@classmoji/database';

// There is no delete here on purpose: a team keeps at least one tag, and the
// only way to take one off is teamAdmin.removeTeamTag, which enforces that.
export const create = async (teamId: string, tagId: string) => {
  return getPrisma().teamTag.create({
    data: {
      team_id: teamId,
      tag_id: tagId,
    },
  });
};
