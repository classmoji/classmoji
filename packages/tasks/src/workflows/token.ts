import { task } from '@trigger.dev/sdk';
import { retryOnDatabaseBlip } from '../helpers/databaseRetry.ts';
import { ClassmojiService } from '@classmoji/services';
import { parseAuditActor } from '@classmoji/services/audit';

export const assignTokensToStudentTask = task({
  id: 'assign_tokens_to_student',
  queue: {
    concurrencyLimit: 10,
  },
  // A blip used to skip a student silently in a class-wide grant. One
  // transaction, so a failed attempt has written nothing; the audit row is
  // written after it commits and never throws.
  ...retryOnDatabaseBlip,
  run: async (payload: {
    student: { id: string | number };
    classroomId: string;
    amount: number;
    description?: string;
    /**
     * Who the grant is recorded for (the web grant form names the owner who
     * sent it). A run queued without one records nothing.
     */
    auditActor?: unknown;
  }) => {
    const { student, classroomId, amount, description } = payload;

    // The actor is read field by field, never spread from the stored payload.
    const { transaction } = await ClassmojiService.token.grantTokens({
      studentId: String(student.id),
      classroomId: String(classroomId),
      amount,
      description,
      actor: parseAuditActor(payload.auditActor),
    });
    return transaction;
  },
});
