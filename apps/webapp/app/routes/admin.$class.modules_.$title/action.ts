import { namedAction } from 'remix-utils/named-action';
import { calculateContributions } from './helpers';
import { ClassmojiService, HelperService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { ActionTypes } from '~/constants';
import { tasks } from '@trigger.dev/sdk/v3';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, userId: _userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'module_action',
  });

  const data = await request.json();

  return namedAction(request, {
    async calculateContributions() {
      const result = await calculateContributions(data.module, classSlug);

      return result;
    },
    async deleteRepo() {
      await HelperService.deleteRepository({
        name: data.repo.name,
        gitOrganization: classroom.git_organization,
        id: data.repo.id,
        deleteFromGithub: true,
      });
      return {
        action: data.action,
        success: 'Repository deleted',
      };
    },

    async addGrader() {
      await HelperService.addGraderToRepositoryAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        repositoryAssignmentId: data.repoAssignmentId,
      });

      return {
        action: ActionTypes.ADD_GRADER,
        success: 'Grader added',
      };
    },

    async removeGrader() {
      await HelperService.removeGraderFromRepositoryAssignment({
        repoName: data.repoName,
        gitOrganization: classroom.git_organization,
        githubIssueNumber: data.githubIssueNumber,
        graderLogin: data.graderLogin,
        graderId: data.graderId,
        repositoryAssignmentId: data.repoAssignmentId,
      });

      return {
        action: ActionTypes.REMOVE_GRADER,
        success: 'Grader removed',
      };
    },

    async publishAssignment() {
      await ClassmojiService.assignment.update(data.assignment_id, { is_published: true });
      return { success: 'Assignment published' };
    },

    async unpublishAssignment() {
      await ClassmojiService.assignment.update(data.assignment_id, { is_published: false });
      return { success: 'Assignment unpublished' };
    },

    async createProjects() {
      // Trigger the backfill task to create projects for repos without them
      const handle = await tasks.trigger('gh-create_projects_for_module', {
        moduleId: data.moduleId,
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
