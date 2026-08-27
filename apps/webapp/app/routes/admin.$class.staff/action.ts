import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * Mutations for the Teaching Staff screen — OWNER only, and this gate is this
 * action's OWN.
 *
 * React Router runs the matched LEAF action first; a parent layout loader only
 * runs afterwards, for revalidation. So nothing about sitting under /admin gates
 * anything here. The route's LOADER reads at the teaching-team tier (an
 * assistant may see who is on the team); these writes are deliberately narrower
 * and must stay that way.
 */
export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEACHING_STAFF',
    action: 'manage_staff',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async createStaff() {
      try {
        // The GitHub profile is resolved server-side by the service from the
        // login alone, so the client cannot choose the provider_id the account
        // is keyed to. `classroom.id` is the classroom requireClassroomAdmin
        // authorized, not a fresh lookup on the same slug.
        const result = await ClassmojiService.staff.addStaff({
          classroomId: classroom.id,
          login: data.login,
          role: 'ASSISTANT',
          name: data.name,
          email: data.email,
        });

        if (result.alreadyExists) {
          return {
            action: ActionTypes.SAVE_USER,
            error: `${result.login} is already an assistant in this class.`,
          };
        }

        return {
          success: 'Assistant added',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        console.error('createStaff failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Failed to add staff member. Please try again.',
        };
      }
    },

    async updateStaff() {
      try {
        // The role travels with the login: memberships are unique on
        // (classroom, user, role), so a user who holds two roles here has two
        // rows and the flag belongs to exactly one of them.
        await ClassmojiService.staff.updateStaff({
          classroomId: classroom.id,
          login: data.login,
          role: data.role,
          isGrader: data.isGrader,
        });
        return {
          success: 'Staff member updated',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        // Same shape as the sibling branches: a service failure becomes a
        // callout, not a trip through the route error boundary.
        console.error('updateStaff failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Failed to update staff member.',
        };
      }
    },

    async removeStaff() {
      try {
        // The service resolves the target from the DB by (classroom, login,
        // role) and builds the task payload entirely server-side; the route
        // keeps awaiting the run so the UI can report the finished removal.
        const { runId } = await ClassmojiService.staff.removeStaff({
          classroomId: classroom.id,
          login: data.login,
          role: data.role,
        });

        await waitForRunCompletion(runId);

        return {
          success: 'Staff member removed',
          action: ActionTypes.REMOVE_USER,
        };
      } catch (error: unknown) {
        console.error('removeStaff failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Failed to remove staff member. Please try again.',
        };
      }
    },
  });
};
