import { task } from '@trigger.dev/sdk';
import { retryOnDatabaseBlip } from '../helpers/databaseRetry.ts';
import { ClassmojiService } from '@classmoji/services';

export const assignTokensToStudentTask = task({
  id: 'assign_tokens_to_student',
  queue: {
    concurrencyLimit: 10,
  },
  // A blip used to skip a student silently in a class-wide grant. One
  // transaction, so a failed attempt has written nothing.
  ...retryOnDatabaseBlip,
  run: async (payload: {
    student: { id: string | number };
    classroomId: string;
    amount: number;
    description?: string;
  }) => {
    const { student, classroomId, amount, description } = payload;

    return ClassmojiService.token.assignToStudent({
      studentId: String(student.id),
      classroomId: String(classroomId),
      amount,
      description,
    });
  },
});
