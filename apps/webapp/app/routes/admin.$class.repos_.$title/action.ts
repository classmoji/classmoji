import { namedAction } from 'remix-utils/named-action';
import { calculateContributions } from './helpers';
import { ClassmojiService, HelperService } from '@classmoji/services';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { ActionTypes } from '~/constants';
import { tasks } from '@trigger.dev/sdk/v3';
import type { Route } from './+types/route';

const REPO_NOT_FOUND = 'Repository not found.';
const SUBMISSION_NOT_FOUND = 'Submission not found.';

/**
 * The repository page's writes. The request body names things only by id; each
 * one is loaded from the authorized classroom before it is used, and the names
 * that reach GitHub (repo names, logins, issue numbers) are the stored ones.
 */
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

  // The repository this page is for, found by the title in the URL the same way
  // the loader finds it. Student repos and submissions are narrowed to it.
  const loadPageRepository = () =>
    params.title
      ? ClassmojiService.repository.findByClassroomAndTitle(classroom.id, params.title)
      : Promise.resolve(null);

  return namedAction(request, {
    async calculateContributions() {
      const repository = await ClassmojiService.repository.findByIdInClassroom(
        data?.repository?.id,
        classroom.id
      );
      if (!repository) return { action: 'CALCULATE_REPO_CONTRIBUTIONS', error: REPO_NOT_FOUND };

      const result = await calculateContributions({ id: repository.id }, classSlug);

      return result;
    },
    async deleteRepo() {
      const pageRepository = await loadPageRepository();
      const gitRepo = pageRepository
        ? await ClassmojiService.gitRepo.findByIdInClassroom(data?.repo?.id, classroom.id, {
            repositoryId: pageRepository.id,
          })
        : null;
      if (!gitRepo) return { action: ActionTypes.DELETE_REPO, error: REPO_NOT_FOUND };

      // The stored name, in this classroom's organization.
      await HelperService.deleteRepository({
        id: gitRepo.id,
        name: gitRepo.name,
        gitOrganization: classroom.git_organization,
        classroomId: classroom.id,
        deleteFromGithub: true,
      });
      return {
        action: ActionTypes.DELETE_REPO,
        success: 'Repository deleted',
      };
    },

    async addGrader() {
      const pageRepository = await loadPageRepository();
      if (!pageRepository) return { action: ActionTypes.ADD_GRADER, error: SUBMISSION_NOT_FOUND };

      const result = await HelperService.addGraderInClassroom({
        classroomId: classroom.id,
        gitOrganization: classroom.git_organization,
        gitRepoAssignmentId: data?.repoAssignmentId,
        graderId: data?.graderId,
        repositoryId: pageRepository.id,
      });
      if (result.status === 'submission_not_found') {
        return { action: ActionTypes.ADD_GRADER, error: SUBMISSION_NOT_FOUND };
      }
      if (result.status === 'grader_not_eligible') {
        return {
          action: ActionTypes.ADD_GRADER,
          error: 'That person is not a grader in this classroom.',
        };
      }

      return {
        action: ActionTypes.ADD_GRADER,
        success: 'Grader added',
      };
    },

    async removeGrader() {
      const pageRepository = await loadPageRepository();
      if (!pageRepository) {
        return { action: ActionTypes.REMOVE_GRADER, error: SUBMISSION_NOT_FOUND };
      }

      const result = await HelperService.removeGraderInClassroom({
        classroomId: classroom.id,
        gitOrganization: classroom.git_organization,
        gitRepoAssignmentId: data?.repoAssignmentId,
        graderId: data?.graderId,
        repositoryId: pageRepository.id,
      });
      if (result.status === 'submission_not_found') {
        return { action: ActionTypes.REMOVE_GRADER, error: SUBMISSION_NOT_FOUND };
      }
      if (result.status === 'grader_not_assigned') {
        return {
          action: ActionTypes.REMOVE_GRADER,
          error: 'That grader is not assigned to this submission.',
        };
      }

      return {
        action: ActionTypes.REMOVE_GRADER,
        success: 'Grader removed',
      };
    },

    async createProjects() {
      const repository = await ClassmojiService.repository.findByIdInClassroom(
        data?.repositoryId,
        classroom.id
      );
      if (!repository) return { action: 'CREATE_PROJECTS', error: REPO_NOT_FOUND };

      // Trigger the backfill task to create projects for repos without them
      const handle = await tasks.trigger('gh-create_projects_for_repository', {
        repositoryId: repository.id,
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
