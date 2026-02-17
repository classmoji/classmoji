import { task } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';
import { sendEmailTask } from './email.js';

/**
 * Create an extension request (token transaction with type EXTENSION)
 * Extensions are now handled via TokenTransactions in the new schema
 */
export const createExtensionTask = task({
  id: 'request_extension',
  run: async payload => {
    const { studentId, repositoryAssignmentId, classroomId, hours, tokensPerHour, description } = payload;

    // Calculate token cost (negative amount for spending)
    const tokenCost = hours * tokensPerHour;

    await ClassmojiService.token.updateExtension({
      type: 'EXTENSION',
      amount: -tokenCost,
      student_id: studentId,
      classroom_id: classroomId,
      repository_assignment_id: repositoryAssignmentId,
      description: description || `Extension: ${hours} hour(s)`,
    });
  },
});

/**
 * Update an extension transaction status
 */
export const updateExtensionTask = task({
  id: 'update_extension',
  run: async payload => {
    const { transactionId, status } = payload;

    await ClassmojiService.token.updateTransaction(transactionId, {
      status,
    });
  },
  onSuccess: async ({ payload }) => {
    const { student, repositoryAssignment, status } = payload;

    if (!student?.email) return;

    const html = `<p>Hi @${student.login}.</p>
      <p>Your extension request for "${repositoryAssignment?.assignment?.title || 'assignment'}" has been <span style="font-weight:bold">${status.toLowerCase()}</span>.</p>
    `;

    await sendEmailTask.triggerAndWait({
      to: student.email,
      subject: `[Classmoji] Extension Request Status`,
      html: html,
    });
  },
});
