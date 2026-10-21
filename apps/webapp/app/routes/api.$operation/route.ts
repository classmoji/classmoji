import { tasks } from '@trigger.dev/sdk';
import { data } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { getAuthSession } from '@classmoji/auth/server';

import { ClassmojiService, QuizGradeError } from '@classmoji/services';
import { checkAuth, waitForRunCompletion, assertClassroomAccess } from '~/utils/helpers';
import { impersonatedBy } from '~/routes/admin.$class.ask-moji/impersonation.server';

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

        const { classroom } = await assertClassroomAccess({
          request,
          classroomSlug: orgLogin,
          allowedRoles: ['OWNER'],
          resourceType: 'CLASSROOM_SUBSCRIPTION',
          attemptedAction: 'read_subscription',
        });

        // The tier the Pro gates use (getProStateForClassroomId): an active PRO
        // from any accepted owner, else FREE. Drives the owner sidebar's Pro-only
        // nav items; teachers and assistants get a boolean from their layouts.
        return ClassmojiService.subscription.getClassroomSubscription(classroom.id);
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
      // Authorization is derived from the RegradeRequest record itself, never
      // from ids in the request body. Load the request, resolve its classroom,
      // then require the teaching team — assistants resolve regrades from their
      // queue, so ASSISTANT is included alongside OWNER/TEACHER.
      const requestId = body?.request?.id;
      if (typeof requestId !== 'string' || !requestId) {
        return data({ error: 'request.id is required' }, { status: 400 });
      }

      const [regradeRequest] = await ClassmojiService.regradeRequest.findMany({
        id: requestId,
      });

      if (!regradeRequest) {
        return data({ error: 'Regrade request not found' }, { status: 404 });
      }

      // Authorize on the record's classroom_id. Loading the classroom and then
      // authorizing against its slug would re-resolve through a second lookup,
      // leaving nothing that ties the authorized classroom to the regrade
      // request being updated below.
      const { userId } = await assertClassroomAccess({
        request,
        classroomId: regradeRequest.classroom_id,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'REGRADE_REQUEST',
        attemptedAction: 'update_regrade_request',
        metadata: {
          regrade_request_id: regradeRequest.id,
        },
      });

      const status = body?.status;
      if (status !== 'APPROVED' && status !== 'DENIED') {
        return data({ error: 'status must be APPROVED or DENIED' }, { status: 400 });
      }
      const reply = typeof body?.comment === 'string' ? body.comment.trim() : '';

      // A quiz request: resolveQuiz writes the status, the reply and any
      // adjustment (APPROVED takes `emoji`, an emoji on the classroom's scale)
      // and its own audit rows; `quiz_regrade_resolved` then emails the student
      // from the database. It never runs `update_regrade_request`, which
      // refuses quiz requests, and never touches repo grades.
      if (regradeRequest.quiz_attempt_id) {
        let result: Awaited<ReturnType<typeof ClassmojiService.regradeRequest.resolveQuiz>>;
        try {
          result = await ClassmojiService.regradeRequest.resolveQuiz({
            requestId: regradeRequest.id,
            resolution: status,
            ...(status === 'APPROVED' && typeof body?.emoji === 'string'
              ? { emoji: body.emoji }
              : {}),
            comment: reply,
            actorUserId: userId,
            tool: 'web:api.updateRegradeRequest',
            impersonatedBy: await impersonatedBy(request),
          });
        } catch (error: unknown) {
          if (error instanceof QuizGradeError) {
            return data(
              { action: 'UPDATE_REGRADE_REQUEST', error: error.message, code: error.code },
              { status: error.status }
            );
          }
          throw error;
        }
        if (!result.alreadyResolved) {
          try {
            await tasks.trigger('quiz_regrade_resolved', { request_id: regradeRequest.id });
          } catch (error: unknown) {
            // The resolution stands; only the email failed to queue.
            console.error('quiz_regrade_resolved enqueue failed:', error);
          }
        }
        return {
          action: 'UPDATE_REGRADE_REQUEST',
          success: result.alreadyResolved
            ? 'This request was already resolved'
            : status === 'APPROVED'
              ? 'Score adjusted'
              : 'Score kept',
        };
      }

      try {
        // Re-derive the task payload from the DB record so the status update and
        // the resolution email use trusted values, not client-supplied ones.
        const run = await tasks.trigger('update_regrade_request', {
          request: {
            id: regradeRequest.id,
            student: {
              email: regradeRequest.student?.email,
            },
            git_repo_assignment: {
              assignment: {
                title: regradeRequest.git_repo_assignment?.assignment?.title,
              },
            },
          },
          data: {
            status,
            // The reply the student reads, when one is given.
            ...(reply ? { grader_comment: reply } : {}),
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

      // Check authorization: OWNER can cancel any, STUDENT can cancel their own.
      // Bound to the transaction's own classroom_id — a slug read back off the
      // classroom record would be re-resolved by the auth layer, so the refund
      // below could be issued against a row in a classroom the caller was never
      // authorized for.
      const {
        userId: _userId,
        membership: _membership,
        isResourceOwner,
        accessGrantedVia: _accessGrantedVia,
      } = await assertClassroomAccess({
        request,
        classroomId: storedTransaction.classroom_id,
        allowedRoles: ['OWNER'], // OWNER can cancel any transaction
        resourceType: 'TOKEN_TRANSACTION',
        attemptedAction: 'cancel_transaction',
        metadata: {
          transaction_id: storedTransaction.id,
        },
        resourceOwnerId: storedTransaction.student_id,
        selfAccessRoles: ['STUDENT'], // Students can cancel their own
      });

      // Only a purchase that is still standing can be cancelled, and only
      // once: the service flips it and writes the refund in one transaction,
      // so a repeated request refunds nothing.
      if (storedTransaction.type !== 'PURCHASE' || storedTransaction.is_cancelled) {
        return data({ error: 'This transaction cannot be cancelled.' }, { status: 400 });
      }
      try {
        await ClassmojiService.token.cancelPurchase(storedTransaction.id);
      } catch (error: unknown) {
        console.error('cancelTokenTransaction failed:', error);
        return data({ error: 'This transaction cannot be cancelled.' }, { status: 400 });
      }

      return {
        action: 'CANCEL_TOKEN_TRANSACTION',
        success: isResourceOwner ? 'Your transaction has been cancelled' : 'Transaction cancelled',
      };
    },
  });
});
