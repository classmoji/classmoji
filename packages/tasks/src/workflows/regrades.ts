import { task } from '@trigger.dev/sdk';
import { appUrl, ClassmojiService, escapeVars } from '@classmoji/services';
import { sendEmailTask } from './email.ts';
import { emojiShortcodes } from '@classmoji/utils';

const emojiMap: Record<string, string> = emojiShortcodes;

interface GitRepoAssignmentGraderRecord {
  grader: {
    email: string;
  };
}

interface GitRepoAssignmentRecord {
  id: string;
  /** GitHub issue #number — matches the Prisma GitRepoAssignment field. */
  provider_issue_number: number;
  git_repo: {
    name: string;
  };
  assignment: {
    title: string;
  };
  graders?: GitRepoAssignmentGraderRecord[];
}

interface RequestRegradeTaskPayload {
  classroom_id: string;
  gitRepoAssignment: GitRepoAssignmentRecord;
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
    git_repo_assignment: {
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
    const { classroom_id, gitRepoAssignment, student_id, student_comment, previous_grade } =
      payload;

    return ClassmojiService.regradeRequest.create({
      classroom_id,
      git_repo_assignment_id: gitRepoAssignment.id,
      student_id,
      student_comment,
      previous_grade,
    });
  },

  onSuccess: async ({ payload }: TaskPayloadWrapper<RequestRegradeTaskPayload>) => {
    const { classroom_id, gitRepoAssignment, previous_grade, student_comment, student_id } =
      payload;

    const classroom = await ClassmojiService.classroom.findById(classroom_id);
    const student = await ClassmojiService.user.findById(student_id);

    if (!classroom?.git_organization.login || !student) {
      return;
    }

    const issueUrl = `https://github.com/${classroom.git_organization.login}/${gitRepoAssignment.git_repo.name}/issues/${gitRepoAssignment.provider_issue_number}`;

    if (gitRepoAssignment.graders && gitRepoAssignment.graders.length > 0) {
      sendEmailTask.batchTrigger(
        gitRepoAssignment.graders.map(({ grader }) => ({
          payload: {
            to: grader.email,
            template: {
              id: 'regrade-requested',
              // `student_comment` is free-form student input rendered into a
              // TA's inbox, and Resend injects variables raw — escaping here is
              // the only thing standing between the two.
              variables: escapeVars({
                STUDENT_NAME: student.name,
                STUDENT_LOGIN: student.login,
                ASSIGNMENT_TITLE: gitRepoAssignment.assignment.title,
                ISSUE_URL: issueUrl,
                PREVIOUS_GRADE: previous_grade.map(grade => emojiMap[grade] || grade).join(' '),
                STUDENT_COMMENT: student_comment || 'None',
              }),
            },
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
      template: {
        id: 'regrade-resolved',
        variables: escapeVars({
          ASSIGNMENT_TITLE: request.git_repo_assignment.assignment.title,
          APP_URL: appUrl(),
        }),
      },
    });
  },
});
