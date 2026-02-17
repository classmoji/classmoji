import async from 'async';
import { namedAction } from 'remix-utils/named-action';
import invariant from 'tiny-invariant';
import { sleep } from '~/utils/helpers';
import prisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const action = async ({ request, params }) => {
  const { class: classSlug, slug } = params;

  invariant(slug, 'Team slug is required');

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'edit_team',
  });

  const data = await request.json();

  return namedAction(request, {
    async addMembersToTeam() {
      const { members } = data;

      const gitOrgLogin = classroom.git_organization?.login;
      if (!gitOrgLogin) {
        throw new Response('Git organization not configured', { status: 400 });
      }
      const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
      const gitProvider = getGitProvider(classroom.git_organization);

      const membersQueue = async.queue(async login => {
        const user = await ClassmojiService.user.findByLogin(login);

        await gitProvider.addTeamMember(gitOrgLogin, slug, login);
        await ClassmojiService.teamMembership.addMemberToTeam(team.id, user.id);
        await sleep(250);
      }, 1);

      membersQueue.push(members);
      await membersQueue.drain();

      return {
        success: `Added student(s) to @${slug}.`,
        action: ActionTypes.ADD_TEAM_MEMBER,
      };
    },

    async removeMemberFromTeam() {
      const { login } = data;

      const user = await prisma.user.findUnique({
        where: { login },
      });
      const gitOrgLogin = classroom.git_organization?.login;
      if (!gitOrgLogin) {
        throw new Response('Git organization not configured', { status: 400 });
      }
      const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
      const gitProvider = getGitProvider(classroom.git_organization);

      await gitProvider.removeTeamMember(gitOrgLogin, slug, login);
      await ClassmojiService.teamMembership.removeMemberFromTeam(team.id, user.id);
      return {
        success: `Removed ${login} from @${slug}.`,
        action: ActionTypes.REMOVE_TEAM_MEMBER,
      };
    },

    async addTeamTags() {
      const { teamId, tags } = data;

      await Promise.all(tags.map(tag => ClassmojiService.teamTag.create(teamId, tag)));

      return {
        success: 'Tag added successfully',
        action: ActionTypes.ADD_TEAM_TAG,
      };
    },

    async removeTeamTag() {
      const { id } = data;
      await ClassmojiService.teamTag.delete(id);
      return {
        success: 'Tag removed successfully',
        action: ActionTypes.REMOVE_TEAM_TAG,
      };
    },
  });
};
