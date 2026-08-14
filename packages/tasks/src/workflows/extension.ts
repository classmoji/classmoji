import { task } from '@trigger.dev/sdk';
import { appUrl, ClassmojiService, escapeVars } from '@classmoji/services';
import { sendEmailTask } from './email.ts';

/**
 * Create an extension request (token transaction with type EXTENSION)
 * Extensions are now handled via TokenTransactions in the new schema
 */
export const createExtensionTask = task({
  id: 'request_extension',
  run: async (payload: {
    studentId: string;
    repositoryAssignmentId: string;
    classroomId: string;
    hours: number;
    tokensPerHour: number;
    description?: string;
  }) => {
    const { studentId, repositoryAssignmentId, classroomId, hours, tokensPerHour, description } =
      payload;

    // Calculate token cost (negative amount for spending)
    const tokenCost = hours * tokensPerHour;

    await ClassmojiService.token.updateExtension({
      type: 'EXTENSION',
      amount: -tokenCost,
      student_id: studentId,
      classroom_id: classroomId,
      git_repo_assignment_id: repositoryAssignmentId,
      description: description || `Extension: ${hours} hour(s)`,
    });
  },
});

/**
 * Update an extension transaction status
 */
export const updateExtensionTask = task({
  id: 'update_extension',
  run: async (payload: {
    transactionId: string;
    status: string;
    student?: { login: string; email?: string };
    gitRepoAssignment?: { assignment?: { title?: string } };
  }) => {
    const { transactionId, status } = payload;

    await ClassmojiService.token.updateTransaction(transactionId, {
      status,
    });
  },
  onSuccess: async ({
    payload,
  }: {
    payload: {
      transactionId: string;
      status: string;
      student?: { login: string; email?: string };
      gitRepoAssignment?: { assignment?: { title?: string } };
    };
  }) => {
    const { student, gitRepoAssignment, status } = payload;

    if (!student?.email) return;

    // `status` is an allowlisted enum upstream (IN_REVIEW | APPROVED | DENIED),
    // but it leaked into the copy as snake_case — "has been in_review".
    const statusLabel = status.toLowerCase().replace(/_/g, ' ');

    await sendEmailTask.triggerAndWait({
      to: student.email,
      template: {
        id: 'extension-status',
        variables: escapeVars({
          STUDENT_LOGIN: student.login,
          ASSIGNMENT_TITLE: gitRepoAssignment?.assignment?.title || 'your assignment',
          STATUS_LABEL: statusLabel,
          APP_URL: appUrl(),
        }),
      },
    });
  },
});
