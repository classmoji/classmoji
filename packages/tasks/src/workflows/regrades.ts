/**
 * Regrade/resubmit request workflows.
 *
 * Repo submissions: `request_regrade` creates the request (in-app notice to
 * the assigned graders) and emails them; `update_regrade_request` writes the
 * resolution and emails the student.
 *
 * Quiz attempts never go through those two. A quiz request is created by
 * `regradeRequest.createForQuizAttempt`, whose in-app notice to the
 * classroom's owners and teachers is also its only staff email (preference
 * gated, `notification` template), so staff get one email per request. It is
 * resolved by `regradeRequest.resolveQuiz`, which writes the status, the reply
 * and any grade adjustment itself; the caller then triggers
 * `quiz_regrade_resolved` with the request id only, and that task re-reads the
 * resolved request and emails the student: "Score adjusted X → Y" or "Score
 * kept X", plus the reply. Grades are emoji, never percentages (a `score-N`
 * badge reads as its number, as in the repo emails). No repo grade is cleared
 * or touched for a quiz request. `update_regrade_request` refuses a quiz
 * request, so a stale caller cannot flip one without its adjustment.
 */
import { task } from '@trigger.dev/sdk';
import { retryOnDatabaseBlip } from '../helpers/databaseRetry.ts';
import { appUrl, ClassmojiService, escapeHtml, escapeVars } from '@classmoji/services';
import { sendBatchEmailTask, sendEmailTask } from './email.ts';
import { getEmojiSymbol, gitContextFor, gitWeb, quizAttemptGrade } from '@classmoji/utils';

interface GitRepoAssignmentGraderRecord {
  grader: {
    email: string;
  };
}

interface GitRepoAssignmentRecord {
  id: string;
  /** GitHub issue #number — matches the Prisma GitRepoAssignment field. */
  provider_issue_number: number | null;
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
    git_repo_assignment?: {
      assignment?: {
        title?: string | null;
      } | null;
    } | null;
  };
  /**
   * The resolution: `status` (APPROVED | DENIED), the reply (`grader_comment`,
   * optional) and who resolved it (`resolved_by_id`, the caller's session or
   * token user). Kept in this shape so a payload queued before or after a
   * deploy still resolves.
   */
  data: {
    status?: unknown;
    grader_comment?: unknown;
    resolved_by_id?: unknown;
    [key: string]: unknown;
  };
}

interface TaskPayloadWrapper<TPayload> {
  payload: TPayload;
}

export const requestRegradeTask = task({
  id: 'request_regrade',
  // Connection blips only: a failed create has written nothing.
  ...retryOnDatabaseBlip,
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

    // The submission on its git host: the issue in ISSUE mode, the repo in REPO mode.
    const web = gitWeb(gitContextFor(classroom));
    // Name the student as their git host knows them: on Gitlab that's their
    // Gitlab username, not `login` (the Github one when Github is connected).
    const studentHandle = web.isGitLab
      ? ((await ClassmojiService.user.findProviderUsernames([student.id], 'GITLAB')).get(
          student.id
        ) ?? student.login)
      : student.login;
    const issueUrl =
      gitRepoAssignment.provider_issue_number != null
        ? web.issue(gitRepoAssignment.git_repo.name, gitRepoAssignment.provider_issue_number)
        : web.repo(gitRepoAssignment.git_repo.name);

    if (gitRepoAssignment.graders && gitRepoAssignment.graders.length > 0) {
      // One batched request rather than one run (and one API request) per
      // grader — Resend's 10 req/s ceiling is shared team-wide.
      sendBatchEmailTask.trigger({
        emails: gitRepoAssignment.graders.map(({ grader }) => ({
          to: grader.email,
          template: {
            id: 'regrade-requested',
            // `student_comment` is free-form student input rendered into a TA's
            // inbox, and Resend injects variables raw — escaping here is the
            // only thing standing between the two.
            variables: escapeVars({
              STUDENT_NAME: student.name,
              STUDENT_LOGIN: studentHandle,
              ASSIGNMENT_TITLE: gitRepoAssignment.assignment.title,
              ISSUE_URL: issueUrl,
              PREVIOUS_GRADE: previous_grade.map(grade => getEmojiSymbol(grade)).join(' '),
              STUDENT_COMMENT: student_comment || 'None',
            }),
          },
        })),
      });
    }
  },
});

export const updateRegradeRequestTask = task({
  id: 'update_regrade_request',
  // Sets fields, so safe to repeat on a connection blip.
  ...retryOnDatabaseBlip,
  run: async (payload: UpdateRegradeRequestTaskPayload) => {
    const { request, data } = payload;
    if (data.status !== 'APPROVED' && data.status !== 'DENIED') {
      throw new Error('update_regrade_request needs status APPROVED or DENIED');
    }

    // resolveRepo refuses a quiz request: regradeRequest.resolveQuiz writes
    // its adjustment with the status, and a bare status write here would mark
    // it APPROVED with no adjustment.
    return ClassmojiService.regradeRequest.resolveRepo({
      id: request.id,
      status: data.status,
      graderComment: typeof data.grader_comment === 'string' ? data.grader_comment : null,
      resolvedById: typeof data.resolved_by_id === 'string' ? data.resolved_by_id : null,
    });
  },
  onSuccess: async ({ payload }: TaskPayloadWrapper<UpdateRegradeRequestTaskPayload>) => {
    const { request } = payload;
    sendEmailTask.trigger({
      to: request.student.email,
      template: {
        id: 'regrade-resolved',
        variables: escapeVars({
          ASSIGNMENT_TITLE: request.git_repo_assignment?.assignment?.title ?? 'your assignment',
          APP_URL: appUrl(),
        }),
      },
    });
  },
});

interface QuizRegradeResolvedPayload {
  /** The resolved quiz request. Everything else is re-read from the database. */
  request_id: string;
}

/** What the student is told about their resolved quiz request. */
export interface QuizRegradeResolution {
  classroomName: string | null;
  studentName: string | null;
  quizName: string;
  attemptNumber: number | null;
  status: 'APPROVED' | 'DENIED';
  /** The grade the student asked about (the request's snapshot), as a shortcode. */
  previousEmoji: string | null;
  /** The attempt's grade now, as a shortcode. */
  currentEmoji: string | null;
  reply: string | null;
}

const symbol = (emoji: string | null) => (emoji ? getEmojiSymbol(emoji) : '—');

/**
 * The resolution email for a quiz request, as variables of the `notification`
 * template (pre-rendered, escaped HTML plus a plain-text twin; no template
 * change or Resend sync needed). "Score adjusted X → Y" or "Score kept X",
 * then the staff reply. No percentages.
 */
export const renderQuizRegradeResolvedEmail = (r: QuizRegradeResolution) => {
  const cls = r.classroomName ?? 'your classroom';
  const what = r.attemptNumber ? `${r.quizName} (attempt ${r.attemptNumber})` : r.quizName;
  const outcome =
    r.status === 'APPROVED'
      ? `Score adjusted ${symbol(r.previousEmoji)} → ${symbol(r.currentEmoji)}`
      : `Score kept ${symbol(r.currentEmoji ?? r.previousEmoji)}`;
  const sentence = `Your regrade request for ${what} in ${cls} has been reviewed.`;
  const greetingHtml = r.studentName
    ? `<p style="margin-top:0;">Hi ${escapeHtml(r.studentName)},</p>`
    : '';
  const greetingText = r.studentName ? `Hi ${r.studentName},\n\n` : '';
  const replyHtml = r.reply
    ? `<p style="margin-bottom:4px;">Reply from your instructor:</p><p style="margin-top:0; margin-bottom:0; padding-left:12px; border-left:3px solid #e7e5e4; white-space:pre-wrap;">${escapeHtml(r.reply)}</p>`
    : '';
  const replyText = r.reply ? `\n\nReply from your instructor:\n${r.reply}` : '';
  return {
    id: 'notification' as const,
    variables: {
      SUBJECT: `[Classmoji]${r.classroomName ? ` ${r.classroomName}` : ''} - Regrade request resolved`,
      PREHEADER: escapeHtml(`${sentence} ${outcome}.`),
      MESSAGE_HTML: `${greetingHtml}<p style="margin-top:0;">Your regrade request for <strong>${escapeHtml(what)}</strong> in <strong>${escapeHtml(cls)}</strong> has been reviewed.</p><p${replyHtml ? '' : ' style="margin-bottom:0;"'}><strong>${escapeHtml(outcome)}</strong></p>${replyHtml}`,
      MESSAGE_TEXT: `${greetingText}${sentence}\n\n${outcome}${replyText}`,
      ACTION_URL: `${appUrl()}/select-organization`,
      PREFS_URL: `${appUrl()}/settings/notifications`,
    },
  };
};

/**
 * Email the student that their quiz regrade request was resolved. Triggered
 * by the resolving surface (webapp, MCP) after `regradeRequest.resolveQuiz`
 * wrote the resolution; only the request id travels, so the email says what
 * the database says. Sends nothing for a repo request or one still open.
 */
export const quizRegradeResolvedTask = task({
  id: 'quiz_regrade_resolved',
  // Reads only before the one send: safe to repeat on a connection blip.
  ...retryOnDatabaseBlip,
  run: async ({ request_id }: QuizRegradeResolvedPayload) => {
    const [request] = await ClassmojiService.regradeRequest.findMany({ id: request_id });
    const attempt = request?.quiz_attempt;
    if (!request || !attempt || (request.status !== 'APPROVED' && request.status !== 'DENIED')) {
      return { sent: false as const };
    }
    const to = request.student?.email;
    if (!to) return { sent: false as const };

    const [classroom, scale] = await Promise.all([
      ClassmojiService.classroom.findById(request.classroom_id),
      ClassmojiService.emojiMapping.findScaleByClassroomId(request.classroom_id),
    ]);
    const grade = quizAttemptGrade(attempt, scale);
    const template = renderQuizRegradeResolvedEmail({
      classroomName: classroom?.name ?? null,
      studentName: request.student?.name ?? null,
      quizName: attempt.quiz?.assignment?.title ?? attempt.quiz?.name ?? 'your quiz',
      attemptNumber: attempt.attempt_number ?? null,
      status: request.status,
      previousEmoji: request.previous_grade[0] ?? grade.original.emoji,
      currentEmoji: grade.effective.emoji,
      reply: request.grader_comment ?? null,
    });

    await sendEmailTask.trigger({ to, template });
    return { sent: true as const };
  },
});
