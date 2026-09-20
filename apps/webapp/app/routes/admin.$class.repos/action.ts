import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { publishAssignment, syncAssignment } from './helpers';
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

  const data = await request.json();
  const assignmentId = data.assignment_id;

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
      return calculateContributions({ id: assignmentId }, classSlug);
    },
  });
};
