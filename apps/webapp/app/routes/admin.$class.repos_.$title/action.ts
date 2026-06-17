import { namedAction } from 'remix-utils/named-action';
import { calculateContributions } from './helpers';
import { HelperService, ClassmojiService } from '@classmoji/services';
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
      const result = await calculateContributions(data.repository, classSlug);

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

    async releaseNow() {
      // Release a repository's assignment(s) immediately instead of waiting for
      // the daily release cron. `assignmentId` releases one; omitting it
      // releases every not-yet-released assignment in the repository.
      const repositoryId = data.repositoryId as string;
      const assignmentIds = data.assignmentId ? [data.assignmentId as string] : undefined;
      const repository = repositoryId
        ? await ClassmojiService.repository.findById(repositoryId)
        : null;

      if (!repository || repository.classroom_id !== classroom.id) {
        return {
          action: 'RELEASE_NOW',
          error: 'Repository not found for this classroom.',
        };
      }

      // Stamp release_at=now first so the student release gate passes once the
      // task marks them published.
      await ClassmojiService.assignment.setReleaseNow(repositoryId, assignmentIds);

      const handle = await tasks.trigger('release_git_repo_assignments_now', {
        repositoryId,
        assignmentIds,
      });

      return {
        action: 'RELEASE_NOW',
        success: assignmentIds ? 'Releasing assignment…' : 'Releasing assignments…',
        taskId: handle.id,
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
