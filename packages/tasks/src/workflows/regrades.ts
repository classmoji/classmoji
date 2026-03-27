import { task } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';
import { sendEmailTask } from './email.ts';
import { emojiShortcodes } from '@classmoji/utils';

const emojiMap: Record<string, string> = emojiShortcodes;

interface RepositoryAssignmentGraderRecord {
  grader: {
    email: string;
  };
}

interface RepositoryAssignmentRecord {
  id: string;
  issue_number: number;
  repository: {
    name: string;
  };
  assignment: {
    title: string;
  };
  graders?: RepositoryAssignmentGraderRecord[];
}

interface RequestRegradeTaskPayload {
  classroom_id: string;
  repositoryAssignment: RepositoryAssignmentRecord;
  student_id: string;
  student_comment?: string | null;
  previous_grade: string[];
}

interface UpdateRegradeRequestTaskPayload {
  request: {
    id: string;
    student: {
      email: string;
    };
    repository_assignment: {
      assignment: {
        title: string;
      };
    };
  };
  data: Record<string, unknown>;
}

interface TaskPayloadWrapper<TPayload> {
  payload: TPayload;
}

export const requestRegradeTask = task({
  id: 'request_regrade',
  run: async (payload: RequestRegradeTaskPayload) => {
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

  onSuccess: async ({ payload }: TaskPayloadWrapper<RequestRegradeTaskPayload>) => {
    const { classroom_id, repositoryAssignment, previous_grade, student_comment, student_id } =
      payload;

    const classroom = await ClassmojiService.classroom.findById(classroom_id);
    const student = await ClassmojiService.user.findById(student_id);

    if (!classroom?.git_organization.login || !student) {
      return;
    }

    const issueUrl = `https://github.com/${classroom.git_organization.login}/${repositoryAssignment.repository.name}/issues/${repositoryAssignment.issue_number}`;

    if (repositoryAssignment.graders && repositoryAssignment.graders.length > 0) {
      sendEmailTask.batchTrigger(
        repositoryAssignment.graders.map(({ grader }) => ({
          payload: {
            to: grader.email,
            subject: '[Classmoji] Action required: Regrade requested',
            html: `<p>${student.name} (@${student.login}) has requested a regrade for
                        <a href="${issueUrl}" style="text-decoration: underline;">${
                          repositoryAssignment.assignment.title
                        }</a>
                     .</p>
                     <p>Previous grade: ${previous_grade
                       .map(grade => emojiMap[grade] || grade)
                       .join(' ')}</p>
                     <p>Student comment: ${student_comment || 'None'}</p>
                     <p>Please review the request and update the grade accordingly.</p>
                     `,
          },
        }))
      );
    }
  },
});

export const updateRegradeRequestTask = task({
  id: 'update_regrade_request',
  run: async (payload: UpdateRegradeRequestTaskPayload) => {
    const { request, data } = payload;

    return ClassmojiService.regradeRequest.update({ id: request.id, data });
  },
  onSuccess: async ({ payload }: TaskPayloadWrapper<UpdateRegradeRequestTaskPayload>) => {
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
