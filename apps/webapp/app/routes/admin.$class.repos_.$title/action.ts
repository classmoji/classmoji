import { namedAction } from 'remix-utils/named-action';
import { GITLAB_UNSUPPORTED, isGitLabClassroom } from '~/utils/gitlabGuard.server';
import { calculateContributions } from './helpers';
import { gitTerms } from '~/utils/gitWeb';
import { HelperService } from '@classmoji/services';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { ActionTypes } from '~/constants';
import { tasks } from '@trigger.dev/sdk/v3';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const {
    classroom,
    userId: _userId,
    membership,
  } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'repository_action',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async calculateContributions() {
      if (isGitLabClassroom(classroom)) return { error: GITLAB_UNSUPPORTED };
      const result = await calculateContributions(data.repository, classSlug);

      return result;
    },
    async deleteRepo() {
      if (isGitLabClassroom(classroom)) return { error: GITLAB_UNSUPPORTED };
      await HelperService.deleteRepository({
        name: data.repo.name,
        gitOrganization: classroom.git_organization,
        id: data.repo.id,
        deleteFromGithub: true,
      });
      return {
        action: data.action,
        success: `${gitTerms(isGitLabClassroom(classroom)).Repo} deleted`,
      };
    },

    async addGrader() {
      await HelperService.addGraderToGitRepoAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        gitRepoAssignmentId: data.repoAssignmentId,
      });

      return {
        action: ActionTypes.ADD_GRADER,
        success: 'Grader added',
      };
    },

    async removeGrader() {
      await HelperService.removeGraderFromGitRepoAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        gitRepoAssignmentId: data.repoAssignmentId,
      });

      return {
        action: ActionTypes.REMOVE_GRADER,
        success: 'Grader removed',
      };
    },

    async createProjects() {
      // Trigger the backfill task to create projects for repos without them
      const handle = await tasks.trigger('gh-create_projects_for_repository', {
        repositoryId: data.repositoryId,
        classroomSlug: classSlug,
      });

      return {
        action: 'CREATE_PROJECTS',
        success: 'Project creation started',
        taskId: handle.id,
      };
    },
  });
};
