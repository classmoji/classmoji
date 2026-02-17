import { task } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';
import { sendEmailTask } from './email.js';
import { emojiShortcodes } from '@classmoji/utils';

export const requestRegradeTask = task({
  id: 'request_regrade',
  run: async payload => {
    const { classroom_id, repositoryAssignment, student_id, student_comment, previous_grade } =
      payload;

    return ClassmojiService.regradeRequest.create({
      classroom_id,
      repository_assignment_id: repositoryAssignment.id,
      student_id,
      student_comment,
      previous_grade,
    });
  },

  onSuccess: async ({ payload }) => {
    const { classroom_id, repositoryAssignment, previous_grade, student_comment, student_id } =
      payload;

    const classroom = await ClassmojiService.classroom.findById(classroom_id);

    const student = await ClassmojiService.user.findById(student_id);

    const issueUrl = `https://github.com/${classroom.git_organization.login}/${repositoryAssignment.repository.name}/issues/${repositoryAssignment.issue_number}`;

    // Only send emails if there are graders assigned
    if (repositoryAssignment.graders && repositoryAssignment.graders.length > 0) {
      sendEmailTask.batchTrigger(
        repositoryAssignment.graders.map(({ grader }) => {
          return {
            payload: {
              to: grader.email,
              subject: '[Classmoji] Action required: Regrade requested',
              html: `<p>${student.name} (@${student.login}) has requested a regrade for
                        <a href="${issueUrl}" style="text-decoration: underline;">${
                          repositoryAssignment.assignment.title
                        }</a>
                     .</p>
                     <p>Previous grade: ${previous_grade
                       .map(grade => emojiShortcodes[grade] || grade)
                       .join(' ')}</p>
                     <p>Student comment: ${student_comment || 'None'}</p>
                     <p>Please review the request and update the grade accordingly.</p>
                     `,
            },
          };
        })
      );
    }
  },
});

export const updateRegradeRequestTask = task({
  id: 'update_regrade_request',
  run: async payload => {
    const { request, data } = payload;

    return ClassmojiService.regradeRequest.update({ id: request.id, data });
  },
  onSuccess: async ({ payload }) => {
    const { request } = payload;
    sendEmailTask.trigger({
      to: request.student.email,
      subject: '[Classmoji] Regrade request resolved',
      html: `<p>Your regrade request for <u>${request.repository_assignment.assignment.title}</u> has been resolved.</p>
             <p>Check your dashboard for the updated grade.</p>
      `,
    });
  },
});
