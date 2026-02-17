import { task } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

export const assignTokensToStudentTask = task({
  id: 'assign_tokens_to_student',
  queue: {
    concurrencyLimit: 10,
  },
  run: async payload => {
    const { student, classroomId, amount, description } = payload;

    return ClassmojiService.token.assignToStudent({
      studentId: String(student.id),
      classroomId: String(classroomId),
      amount,
      description,
    });
  },
});
