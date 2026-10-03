import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { publishAssignment, publishAssignmentAndRepository, syncAssignment } from './helpers';
import { calculateContributions } from './contributions';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, userId, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'manage_repositories',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // Every action here names one record by `assignment_id`; anything else is
  // answered in the route's error shape rather than failing further down.
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return { error: 'Invalid request.' };
  }
  const assignmentId =
    typeof data === 'object' && data !== null
      ? (data as { assignment_id?: unknown }).assignment_id
      : undefined;
  if (typeof assignmentId !== 'string' || !assignmentId) return { error: 'Invalid request.' };

  return namedAction(request, {
    async delete() {
      await ClassmojiService.repository.deleteById(assignmentId, classroom.id);

      return {
        success: 'Repository deleted',
        action: ActionTypes.DELETE_ASSIGNMENT,
      };
    },

    async publish() {
      return publishAssignment(classSlug, classroom.id, assignmentId, userId);
    },

    // One assignment, plus its repository when that still needs provisioning.
    // `assignment_id` really is an assignment id here, unlike the repository-
    // scoped actions around it.
    async publishAssignment() {
      return publishAssignmentAndRepository(classSlug, classroom.id, assignmentId, userId);
    },

    async unpublish() {
      await ClassmojiService.repository.setPublished(assignmentId, false, classroom.id);
      return { success: 'Repository unpublished' };
    },

    async sync() {
      const res = await syncAssignment(classSlug, classroom.id, assignmentId, userId);
      const {
        triggerSession: { numReposToCreate, numIssuesToCreate },
      } = res;

      if (numReposToCreate + numIssuesToCreate == 0)
        return {
          info: 'No missing repo or issue',
        };

      return res;
    },

    // Group repos only: fan out one contribution-stats task per team repo.
    async calculateContributions() {
      const repository = await ClassmojiService.repository.findByIdInClassroom(
        assignmentId,
        classroom.id
      );
      if (!repository) {
        return { action: 'CALCULATE_REPO_CONTRIBUTIONS', error: 'Repository not found.' };
      }
      return calculateContributions({ id: repository.id }, classSlug);
    },
  });
};
