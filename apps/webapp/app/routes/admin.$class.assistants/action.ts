import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'ASSISTANTS',
    action: 'manage_assistants',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async createAssistant() {
      try {
        // The GitHub profile is resolved server-side by the service from the
        // login alone — the form's octokit lookup is UX validation only, so the
        // client can no longer choose the provider_id we key the account to.
        // `classroom.id` is the classroom requireClassroomAdmin authorized, not
        // a fresh lookup on the same slug.
        const result = await ClassmojiService.assistant.addAssistant({
          classroomId: classroom.id,
          login: data.login,
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
          success: 'Assistant created',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        console.error('createAssistant failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Failed to create assistant. Please try again.',
        };
      }
    },

    async updateAssistant() {
      try {
        await ClassmojiService.assistant.updateAssistant({
          classroomId: classroom.id,
          login: data.login,
          isGrader: data.isGrader,
        });
        return {
          success: 'Assistant updated',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        // Same shape as the sibling branches: a service failure becomes a
        // callout, not a trip through the route error boundary.
        console.error('updateAssistant failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Failed to update assistant.',
        };
      }
    },

    async removeAssistant() {
      try {
        // The service resolves the target from the DB by (classroom, login) and
        // builds the task payload entirely server-side; the route keeps awaiting
        // the run so the UI can report the finished removal.
        const { runId } = await ClassmojiService.assistant.removeAssistant({
          classroomId: classroom.id,
          login: data.user?.login,
        });

        await waitForRunCompletion(runId);

        return {
          success: 'Assistant removed',
          action: ActionTypes.REMOVE_USER,
        };
      } catch (error: unknown) {
        console.error('removeAssistant failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Failed to remove assistant. Please try again.',
        };
      }
    },
  });
};
