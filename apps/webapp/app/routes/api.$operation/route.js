import { auth, tasks } from '@trigger.dev/sdk';
import { data } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { nanoid } from 'nanoid';
import { getAuthSession } from '@classmoji/auth/server';

import { ClassmojiService } from '@classmoji/services';
import { checkAuth, waitForRunCompletion, assertClassroomAccess } from '~/utils/helpers';

export const loader = checkAuth(async ({ request, params }) => {
  const { operation } = params;
  const { searchParams } = new URL(request.url);
  const authData = await getAuthSession(request);

  switch (operation) {
    case 'get-org-subscription': {
      const subscription = await ClassmojiService.subscription.getByClassroom(
        searchParams.get('orgLogin')
      );

      return subscription;
    }
    case 'get-tc-installation-token': {
      // TODO: This method needs implementation in GitHubProvider
      return data({ error: 'Method not implemented' }, { status: 501 });
    }
    case 'get-user-by-id': {
      const userId = searchParams.get('userId');
      const orgLogin = searchParams.get('orgLogin');

      if (!userId) {
        return data({ error: 'userId is required' }, { status: 400 });
      }

      if (!orgLogin) {
        return data({ error: 'orgLogin is required' }, { status: 400 });
      }

      try {
        // Verify the requesting user is an OWNER in the classroom
        const classroom = await ClassmojiService.classroom.findBySlug(orgLogin);

        if (!classroom) {
          return data({ error: 'Classroom not found' }, { status: 404 });
        }

        const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
          classroom.id,
          authData.userId
        );

        if (!membership || membership.role !== 'OWNER') {
          return data({ error: 'Unauthorized - OWNER role required' }, { status: 403 });
        }

        // Fetch the user data
        const targetUser = await ClassmojiService.user.findById(userId);

        if (!targetUser) {
          return data({ error: 'User not found' }, { status: 404 });
        }

        // Return only safe fields (no sensitive data)
        return {
          id: targetUser.id,
          name: targetUser.name,
          login: targetUser.login,
        };
      } catch (error) {
        console.error('Error fetching user by ID:', error);
        return data({ error: 'Failed to fetch user' }, { status: 500 });
      }
    }
    default:
      return data({ error: 'Invalid operation' }, { status: 400 });
  }
});

export const action = checkAuth(async ({ request, user }) => {
  const body = await request.json();

  return namedAction(request, {
    async updateRegradeRequest() {
      try {
        const run = await tasks.trigger('update_regrade_request', {
          request: body.request,
          data: {
            status: body.status,
          },
        });

        await waitForRunCompletion(run.id);

        return {
          action: 'UPDATE_REGRADE_REQUEST',
          success: 'Resubmit request updated',
        };
      } catch (error) {
        console.error('updateRegradeRequest failed:', error);
        return {
          action: 'UPDATE_REGRADE_REQUEST',
          error: 'Failed to update resubmit request. Please try again.',
        };
      }
    },
    async cancelTokenTransaction() {
      // First, get the classroom from the transaction's classroom_id
      const classroom = await ClassmojiService.classroom.findById(
        body.transaction.classroom_id
      );

      if (!classroom) {
        return data({ error: 'Classroom not found' }, { status: 404 });
      }

      // Check authorization: OWNER can cancel any, STUDENT can cancel their own
      const { userId, membership, isResourceOwner, accessGrantedVia } = await assertClassroomAccess({
        request,
        classroomSlug: classroom.slug,
        allowedRoles: ['OWNER'],  // OWNER can cancel any transaction
        resourceType: 'TOKEN_TRANSACTION',
        attemptedAction: 'cancel_transaction',
        metadata: {
          transaction_id: body.transaction.id,
        },
        resourceOwnerId: body.transaction.student_id,
        selfAccessRoles: ['STUDENT'],  // Students can cancel their own
      });

      await cancelTokenTransactionHandler(body.transaction);

      return {
        action: 'CANCEL_TOKEN_TRANSACTION',
        success: isResourceOwner ? 'Your transaction has been cancelled' : 'Transaction cancelled',
      };
    },

    async deleteRepositories() {
      const { deleteFromGithub, repositories, classSlug } = body;
      const classroom = await ClassmojiService.classroom.findBySlug(classSlug);

      if (!classroom) {
        return data({ error: 'Classroom not found' }, { status: 404 });
      }

      const sessionId = nanoid();
      const payloads = await Promise.all(
        repositories.map(async repo => {
          const repository = await ClassmojiService.repository.find({
            name: repo.name,
            classroom_id: classroom.id,
          });

          return {
            payload: {
              id: repository?.id,
              name: repo.name,
              gitOrganization: classroom.git_organization,
              deleteFromGithub,
            },
            options: {
              tags: [`session_${sessionId}`],
            },
          };
        })
      );

      const accessToken = await auth.createPublicToken({
        scopes: {
          read: {
            tags: [`session_${sessionId}`],
          },
        },
      });

      const numReposToDelete = repositories.length;

      await tasks.batchTrigger('delete_repository', payloads);

      return {
        triggerSession: { accessToken, id: sessionId, numReposToDelete },
      };
    },
  });
});

const cancelTokenTransactionHandler = async transaction => {
  const { classroom_id, student_id, amount, repository_assignment_id, hours_purchased } = transaction;

  await ClassmojiService.token.updateTransaction(transaction.id, {
    is_cancelled: true,
  });

  await ClassmojiService.token.updateExtension({
    classroom_id,
    student_id,
    repository_assignment_id,
    amount: Math.abs(amount),
    hours_purchased: hours_purchased * -1,
    type: 'REFUND',
    description: `Refund of ${hours_purchased} hours.`,
  });
};
