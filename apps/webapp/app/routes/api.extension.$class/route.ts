import { namedAction } from 'remix-utils/named-action';
import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { assertClassroomAccess, waitForRunCompletion, assertClassroomMutationAllowed } from '~/utils/helpers';
import type { Route } from './+types/route';

// TokenTransaction has no `status` column; this endpoint's status is only used
// to label the notification email. Bound it to a known, closed set (mirrors the
// RegradeRequestStatus workflow) so the request body cannot inject arbitrary
// text into the email that is sent to the student.
const ALLOWED_EXTENSION_STATUSES = ['IN_REVIEW', 'APPROVED', 'DENIED'];

export const loader = async () => {
  return null;
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const data = await request.json();

  return namedAction(request, {
    async createExtension() {
      const repositoryAssignmentId = data.repositoryAssignmentId ?? data.git_repo_assignment_id;

      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'EXTENSION',
        attemptedAction: 'create_extension',
        metadata: { repository_assignment_id: repositoryAssignmentId, hours: data.hours },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      // Treat the request body as ids only. Price, target student, and classroom
      // are all re-derived from the DB so a crafted body cannot mint tokens,
      // set its own price, or write into another classroom.
      if (typeof repositoryAssignmentId !== 'string' || !repositoryAssignmentId) {
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Missing repository assignment ID.',
        };
      }

      const hours = Number(data.hours);
      if (!Number.isInteger(hours) || hours <= 0) {
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Invalid hours: must be a positive whole number.',
        };
      }

      const repoAssignment = await ClassmojiService.gitRepoAssignment.findById(repositoryAssignmentId);
      if (!repoAssignment || repoAssignment.git_repo?.classroom_id !== classroom.id) {
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Repository assignment not found.',
        };
      }

      // Token transactions are per-student; team repositories have no single
      // owner to charge, so extensions are only valid on individual repos.
      const studentId = repoAssignment.git_repo?.student_id;
      if (!studentId) {
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Extensions can only be granted on individual student repositories.',
        };
      }

      const tokensPerHour = repoAssignment.assignment?.tokens_per_hour ?? 0;
      if (tokensPerHour <= 0) {
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Token cost is not configured for this assignment.',
        };
      }

      try {
        const run = await tasks.trigger('request_extension', {
          classroomId: classroom.id,
          studentId,
          repositoryAssignmentId: repoAssignment.id,
          hours,
          tokensPerHour,
        });

        await waitForRunCompletion(run.id);

        return {
          action: ActionTypes.REQUEST_EXTENSION,
          success: 'Extension created successfully',
        };
      } catch (error: unknown) {
        console.error('createExtension failed:', error);
        return {
          action: ActionTypes.REQUEST_EXTENSION,
          error: 'Failed to create extension. Please try again.',
        };
      }
    },

    async updateExtension() {
      const transactionId = data.transactionId ?? data.transaction_id;

      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'EXTENSION',
        attemptedAction: 'update_extension',
        metadata: { transaction_id: transactionId },
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      if (typeof transactionId !== 'string' || !transactionId) {
        return {
          action: ActionTypes.UPDATE_EXTENSION,
          error: 'Missing transaction ID.',
        };
      }

      const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
      if (!ALLOWED_EXTENSION_STATUSES.includes(status)) {
        return {
          action: ActionTypes.UPDATE_EXTENSION,
          error: 'Invalid extension status.',
        };
      }

      // Load the transaction and confirm it belongs to the authorized classroom
      // before mutating it. The notification email fields are read from trusted
      // DB records, never from the request body.
      const [transaction] = await ClassmojiService.token.findTransactions({ id: transactionId });
      if (!transaction || transaction.classroom_id !== classroom.id) {
        return {
          action: ActionTypes.UPDATE_EXTENSION,
          error: 'Extension transaction not found.',
        };
      }

      try {
        const run = await tasks.trigger('update_extension', {
          transactionId: transaction.id,
          status,
          student: {
            login: transaction.student?.login ?? '',
            email: transaction.student?.email ?? undefined,
          },
          gitRepoAssignment: {
            assignment: {
              title: transaction.git_repo_assignment?.assignment?.title,
            },
          },
        });

        await waitForRunCompletion(run.id);

        return {
          action: ActionTypes.UPDATE_EXTENSION,
          success: 'Extension updated successfully',
        };
      } catch (error: unknown) {
        console.error('updateExtension failed:', error);
        return {
          action: ActionTypes.UPDATE_EXTENSION,
          error: 'Failed to update extension. Please try again.',
        };
      }
    },
  });
};
