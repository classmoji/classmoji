import { auth, tasks } from '@trigger.dev/sdk';
import { data } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { nanoid } from 'nanoid';
import { getAuthSession } from '@classmoji/auth/server';

import { ClassmojiService } from '@classmoji/services';
import { checkAuth, waitForRunCompletion, assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';

export const loader = checkAuth(
  async ({ request, params }: { request: Request; params: Record<string, string | undefined> }) => {
    const { operation } = params;
    const { searchParams } = new URL(request.url);
    const authData = await getAuthSession(request);

    switch (operation) {
      case 'get-org-subscription': {
        const orgLogin = searchParams.get('orgLogin');
        if (!orgLogin) {
          return data({ error: 'orgLogin is required' }, { status: 400 });
        }

        await assertClassroomAccess({
          request,
          classroomSlug: orgLogin,
          allowedRoles: ['OWNER'],
          resourceType: 'CLASSROOM_SUBSCRIPTION',
          attemptedAction: 'read_subscription',
        });

        const subscription = await ClassmojiService.subscription.getByClassroom(orgLogin);
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
            authData!.userId
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
        } catch (error: unknown) {
          console.error('Error fetching user by ID:', error);
          return data({ error: 'Failed to fetch user' }, { status: 500 });
        }
      }
      default:
        return data({ error: 'Invalid operation' }, { status: 400 });
    }
  }
);

export const action = checkAuth(async ({ request }: { request: Request }) => {
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
      } catch (error: unknown) {
        console.error('updateRegradeRequest failed:', error);
        return {
          action: 'UPDATE_REGRADE_REQUEST',
          error: 'Failed to update resubmit request. Please try again.',
        };
      }
    },
    async cancelTokenTransaction() {
      // Re-derive every authorization-relevant and financial field from the DB.
      // Body fields other than transaction.id are NOT trusted (prior bug: a
      // caller could inflate refund amount by setting body.transaction.amount).
      const transactionId = body?.transaction?.id;
      if (typeof transactionId !== 'string' || !transactionId) {
        return data({ error: 'transaction.id is required' }, { status: 400 });
      }

      const [storedTransaction] = await ClassmojiService.token.findTransactions({
        id: transactionId,
      });

      if (!storedTransaction) {
        return data({ error: 'Transaction not found' }, { status: 404 });
      }

      const classroom = await ClassmojiService.classroom.findById(storedTransaction.classroom_id);

      if (!classroom) {
        return data({ error: 'Classroom not found' }, { status: 404 });
      }

      // Check authorization: OWNER can cancel any, STUDENT can cancel their own
      const {
        userId: _userId,
        membership: _membership,
        isResourceOwner,
        accessGrantedVia: _accessGrantedVia,
      } = await assertClassroomAccess({
        request,
        classroomSlug: classroom.slug,
        allowedRoles: ['OWNER'], // OWNER can cancel any transaction
        resourceType: 'TOKEN_TRANSACTION',
        attemptedAction: 'cancel_transaction',
        metadata: {
          transaction_id: storedTransaction.id,
        },
        resourceOwnerId: storedTransaction.student_id,
        selfAccessRoles: ['STUDENT'], // Students can cancel their own
      });

      await cancelTokenTransactionHandler({
        id: storedTransaction.id,
        classroom_id: storedTransaction.classroom_id,
        student_id: storedTransaction.student_id,
        amount: storedTransaction.amount,
        repository_assignment_id: storedTransaction.repository_assignment_id ?? '',
        hours_purchased: storedTransaction.hours_purchased ?? 0,
      });

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

      const { classroom: accessClassroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classroom.slug,
        allowedRoles: ['OWNER'],
        resourceType: 'REPOSITORY',
        attemptedAction: 'delete_repositories',
      });
      assertClassroomMutationAllowed({ status: accessClassroom.status, role: membership!.role });

      const sessionId = nanoid();
      const payloads = await Promise.all(
        repositories.map(async (repo: { name: string }) => {
          const repository = await ClassmojiService.gitRepo.find({
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

      await tasks.batchTrigger('delete_git_repo', payloads);

      return {
        triggerSession: { accessToken, id: sessionId, numReposToDelete },
      };
    },
  });
});

const cancelTokenTransactionHandler = async (transaction: {
  id: string;
  classroom_id: string;
  student_id: string;
  amount: number;
  git_repo_assignment_id: string;
  hours_purchased: number;
}) => {
  const { classroom_id, student_id, amount, git_repo_assignment_id, hours_purchased } =
    transaction;

  await ClassmojiService.token.updateTransaction(transaction.id, {
    is_cancelled: true,
  });

  await ClassmojiService.token.updateExtension({
    classroom_id,
    student_id,
    git_repo_assignment_id,
    amount: Math.abs(amount),
    hours_purchased: hours_purchased * -1,
    type: 'REFUND',
    description: `Refund of ${hours_purchased} hours.`,
  });
};
