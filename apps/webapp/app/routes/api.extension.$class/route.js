import { namedAction } from 'remix-utils/named-action';
import { tasks } from '@trigger.dev/sdk';

import { ActionTypes } from '~/constants';
import { assertClassroomAccess, waitForRunCompletion } from '~/utils/helpers';

export const loader = async () => {
  return null;
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;
  const data = await request.json();

  return namedAction(request, {
    async createExtension() {
      const { classroom } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'EXTENSION',
        attemptedAction: 'create_extension',
        metadata: { student_id: data.student_id, hours: data.hours },
      });

      try {
        const run = await tasks.trigger('request_extension', {
          classroom,
          ...data,
        });

        await waitForRunCompletion(run.id);

        return {
          action: ActionTypes.REQUEST_EXTENSION,
          success: 'Extension created successfully',
        };
      } catch (error) {
        console.error('createExtension failed:', error);
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Failed to create extension. Please try again.',
        };
      }
    },

    async updateExtension() {
      await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'EXTENSION',
        attemptedAction: 'update_extension',
        metadata: { extension_id: data.extension_id },
      });

      try {
        const run = await tasks.trigger('update_extension', {
          ...data,
        });

        await waitForRunCompletion(run.id);

        return {
          action: ActionTypes.UPDATE_EXTENSION,
          success: 'Extension updated successfully',
        };
      } catch (error) {
        console.error('updateExtension failed:', error);
        return {
          action: ActionTypes.UPDATE_EXTENSION,
          error: 'Failed to update extension. Please try again.',
        };
      }
    },
  });
};
