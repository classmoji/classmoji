import async from 'async';
import { namedAction } from 'remix-utils/named-action';
import invariant from 'tiny-invariant';
import { sleep } from '~/utils/helpers';
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface RepoRename {
  id: string;
  name: string;
}

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const slug = params.slug!;

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

      const membersQueue = async.queue(async (login: string) => {
        const user = await ClassmojiService.user.findByLogin(login);

        await gitProvider.addTeamMember(gitOrgLogin, slug, login);
        await ClassmojiService.teamMembership.addMemberToTeam(team!.id, user!.id);
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

      const user = await getPrisma().user.findUnique({
        where: { login },
      });
      const gitOrgLogin = classroom.git_organization?.login;
      if (!gitOrgLogin) {
        throw new Response('Git organization not configured', { status: 400 });
      }
      const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
      const gitProvider = getGitProvider(classroom.git_organization);

      await gitProvider.removeTeamMember(gitOrgLogin, slug, login);
      await ClassmojiService.teamMembership.removeMemberFromTeam(team!.id, user!.id);
      return {
        success: `Removed ${login} from @${slug}.`,
        action: ActionTypes.REMOVE_TEAM_MEMBER,
      };
    },

    async addTeamTags() {
      const { teamId, tags } = data;

      await Promise.all(tags.map((tag: string) => ClassmojiService.teamTag.create(teamId, tag)));

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

    async renameTeam() {
      const { newName } = data as { newName?: string };
      const trimmed = typeof newName === 'string' ? newName.trim() : '';
      if (!trimmed) {
        throw new Response('New team name is required', { status: 400 });
      }

      const gitOrgLogin = classroom.git_organization?.login;
      if (!gitOrgLogin) {
        throw new Response('Git organization not configured', { status: 400 });
      }
      if (classroom.git_organization?.provider !== 'GITHUB') {
        throw new Response('Team rename is only supported for GitHub organizations', {
          status: 400,
        });
      }

      const team = await ClassmojiService.team.findBySlugAndClassroomId(slug, classroom.id);
      if (!team) {
        throw new Response('Team not found', { status: 404 });
      }

      const teamWithRepos = await ClassmojiService.team.findByIdWithRepositories(team.id);
      const repositories = teamWithRepos?.repositories ?? [];

      const gitProvider = getGitProvider(classroom.git_organization);

      // Rename GitHub team first — it is authoritative for the new slug.
      const updated = await gitProvider.updateTeam(gitOrgLogin, slug, { name: trimmed });
      const newSlug = updated.slug;

      // Collision guard: ensure another local team doesn't already occupy the new slug.
      if (newSlug !== slug) {
        const existing = await ClassmojiService.team.findBySlugAndClassroomId(
          newSlug,
          classroom.id
        );
        if (existing && existing.id !== team.id) {
          throw new Response(
            `A team with slug "${newSlug}" already exists in this classroom`,
            { status: 409 }
          );
        }
      }

      const oldSuffix = `-${slug}`;
      const failed: { name: string; error: string }[] = [];
      const succeeded: RepoRename[] = [];

      const renameQueue = async.queue<(typeof repositories)[number]>(async repo => {
        if (!repo.name.includes(oldSuffix)) {
          return;
        }
        const newRepoName = repo.name.split(oldSuffix).join(`-${newSlug}`);
        try {
          await gitProvider.updateRepo(gitOrgLogin, repo.name, { name: newRepoName });
          succeeded.push({ id: repo.id, name: newRepoName });
        } catch (error: unknown) {
          failed.push({
            name: repo.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await sleep(250);
      }, 1);

      if (repositories.length > 0) {
        renameQueue.push(repositories);
        await renameQueue.drain();
      }

      await ClassmojiService.team.renameAndRepos({
        teamId: team.id,
        newName: updated.name,
        newSlug,
        repoRenames: succeeded,
      });

      return {
        success:
          failed.length === 0
            ? `Renamed team to @${newSlug}.`
            : `Renamed team to @${newSlug}. ${failed.length} repo(s) failed to rename.`,
        action: ActionTypes.RENAME_TEAM,
        newSlug,
        failed,
      };
    },
  });
};
