/**
 * Regrade tools — regrade_create (student self) / regrade_resolve (teaching team).
 *
 * Phase 3 email parity: both web routes wrap these mutations in Trigger.dev
 * tasks whose onSuccess hooks send the emails (grader "action required" on
 * create, student "resolved" on resolve). Per the locked gap policy — where a
 * task is already the orchestrator, MCP triggers the task exactly as the
 * routes do — these tools now fire the SAME tasks with the SAME re-derived
 * payloads (string-id `tasks.trigger`, the routes' idiom) and wait for the
 * run like the routes' waitForRunCompletion. Extracting the email into
 * packages/services instead would invert the dependency graph
 * (packages/tasks already imports @classmoji/services), so task-triggering is
 * the structurally cleaner parity path.
 *
 * regrade_create mirrors apps/webapp/app/routes/student.$class.regrade-requests.new:
 * requireStudentAccess (STUDENT only) + the action's IDOR check — the target
 * submission's git_repo.student_id must equal the authenticated user (derived
 * from the DB, never the request). Note: the web action rejects TEAM-owned
 * submissions (student_id is null on a team repo), even though its loader
 * lists team assignments in the dropdown — MCP mirrors the action. The
 * `previous_grade` String[] snapshot is built HERE from the submission's
 * current grades, exactly as the route builds it (plan §5.1). The task's run
 * is regradeRequest.create (fires the in-app grader notifications); its
 * onSuccess emails the assigned graders.
 *
 * regrade_resolve mirrors api.$operation?action=updateRegradeRequest:
 * teaching-team (['OWNER','TEACHER','ASSISTANT']), authorization derived from
 * the RegradeRequest record's classroom, task payload re-derived from the DB
 * record (never the request). Statuses match the web UI: APPROVED | DENIED.
 *
 * QUIZ TARGET (quiz regrade design, D4/D7). regrade_create takes
 * `quiz_attempt_id` instead of a submission (exactly one of the two): the
 * attempt must be one of this classroom's (else the same not_found as an
 * unknown id), and `regradeRequest.createForQuizAttempt` enforces the rest
 * (the caller's own completed attempt, as a current student; an open request
 * on the attempt is returned instead of a second one, `created: false`). No
 * task runs: the service's in-app notice to the owners and teachers is the
 * staff email, so staff get one email per request. regrade_resolve on a quiz
 * request calls `regradeRequest.resolveQuiz` (APPROVED adjusts the attempt to
 * `emoji`, DENIED keeps it; the reply `comment` is required and stored as
 * grader_comment), then triggers `quiz_regrade_resolved`, which emails the
 * student from the database. Both services write their own audit rows
 * (`data.tool` = the tool name, impersonation included), so the quiz paths
 * write none here. Asking is refused where the classroom shows no quizzes;
 * resolving is not, so an open request is never stranded.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { runs, tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  loadGitRepoAssignmentInClassroom,
  loadRegradeRequestInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
  submissionIdSchema,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';
import { mapQuizGradeError } from './quizAttemptAdjust.ts';

const RUN_POLL_INTERVAL_MS = 500;
const RUN_WAIT_TIMEOUT_MS = 60_000;

/** Success/terminal-failure sets from the SDK's RunStatus enum. */
const FAILED_RUN_STATUSES = new Set([
  'CANCELED',
  'FAILED',
  'CRASHED',
  'SYSTEM_FAILURE',
  'EXPIRED',
  'TIMED_OUT',
]);

/**
 * Wait for a triggered run to finish — the webapp's waitForRunCompletion
 * semantics (throw on any non-COMPLETED terminal status), implemented as
 * bounded polling so a stalled run can never hang the MCP request (S5).
 * Returns the run's output (the task run()'s return value).
 */
async function waitForRunCompletion(runId: string): Promise<unknown> {
  const deadline = Date.now() + RUN_WAIT_TIMEOUT_MS;
  for (;;) {
    const run = await runs.retrieve(runId);
    if (run.status === 'COMPLETED') {
      return run.output;
    }
    if (FAILED_RUN_STATUSES.has(run.status)) {
      throw new ToolError('internal', `Task failed with status: ${run.status}`);
    }
    if (Date.now() >= deadline) {
      throw new ToolError('internal', 'Timed out waiting for the background task to complete');
    }
    await new Promise(resolve => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
  }
}

interface RegradeCreateArgs {
  classroom: string;
  git_repo_assignment_id?: string;
  quiz_attempt_id?: string;
  comment: string;
}

/** A quiz request's target, as the regrade tools return it. */
async function quizTarget(attemptId: string) {
  const attempt = await getPrisma().quizAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      attempt_number: true,
      quiz: { select: { id: true, name: true, classroom_id: true } },
    },
  });
  return attempt
    ? {
        quiz_id: attempt.quiz.id,
        quiz_name: attempt.quiz.name,
        attempt_id: attempt.id,
        attempt_number: attempt.attempt_number ?? null,
        classroom_id: attempt.quiz.classroom_id,
      }
    : null;
}

/** regrade_create on a quiz attempt: the service does the work and the audit. */
async function createQuizRegrade(attemptId: string, comment: string, ctx: ToolContext) {
  const { classroomId } = requireClassroomCtx(ctx);
  if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
    throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
  }
  // S1: an attempt of another classroom is the same not_found as no attempt.
  const target = await quizTarget(attemptId);
  if (!target || target.classroom_id !== classroomId) throw scopedNotFound('Quiz attempt');

  let result: Awaited<ReturnType<typeof ClassmojiService.regradeRequest.createForQuizAttempt>>;
  try {
    result = await ClassmojiService.regradeRequest.createForQuizAttempt({
      attemptId: target.attempt_id,
      comment,
      actorUserId: ctx.viewer.userId,
      tool: 'regrade_create',
      impersonatedBy: ctx.viewer.impersonatedBy ?? null,
    });
  } catch (error) {
    throw mapQuizGradeError(error, 'Quiz attempt');
  }
  if (result.classroomId !== classroomId) throw scopedNotFound('Quiz attempt');

  const { classroom_id: _classroom, ...quiz } = target;
  return ok({
    success: true,
    created: result.created,
    ...(result.created
      ? {}
      : {
          note: 'This attempt already has an open regrade request; it was returned unchanged.',
        }),
    regrade_request: {
      id: result.request.id,
      status: result.request.status,
      target: 'quiz',
      student_comment: result.request.student_comment ?? null,
      previous_grade: result.request.previous_grade,
      quiz,
    },
  });
}

export const regradeCreateTool: ToolDefinition<RegradeCreateArgs> = {
  name: 'regrade_create',
  annotations: { destructive: false },
  title: 'Request a regrade',
  description:
    'Submits a regrade (resubmit) request on YOUR OWN work: a graded submission ' +
    '(git_repo_assignment_id) or a completed quiz attempt (quiz_attempt_id, e.g. ' +
    'counting_attempt_id from my_grades); give exactly one. Students only. Snapshots your ' +
    'current grade (emoji) as previous_grade. A submission notifies its assigned graders, a ' +
    "quiz the classroom's owners and teachers (in-app and by email). If the target already " +
    'has an open request, that one is returned (created: false). You may ask again after a ' +
    'request is resolved. Follow it with my_regrade_requests.',
  scope: 'write',
  roles: ['STUDENT'],
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema()
      .optional()
      .describe('Your submission (GitRepoAssignment) id; or give quiz_attempt_id'),
    quiz_attempt_id: z
      .string()
      .uuid()
      .optional()
      .describe('Your completed quiz attempt id; or give git_repo_assignment_id'),
    comment: z.string().min(1).max(2000).describe('Why the work should be regraded'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const hasSubmission = args.git_repo_assignment_id !== undefined;
    const hasQuiz = args.quiz_attempt_id !== undefined;
    if (hasSubmission === hasQuiz) {
      throw new ToolError(
        'invalid_params',
        'Give exactly one of git_repo_assignment_id or quiz_attempt_id'
      );
    }
    if (args.quiz_attempt_id !== undefined) {
      return createQuizRegrade(args.quiz_attempt_id, args.comment, ctx);
    }
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id as string, ctx);

    // Self-scoping (assertClassroomAccess resourceOwnerId semantics): the
    // submission must belong to the calling student. Same non-leaking error
    // as a cross-classroom miss.
    if (gra.git_repo.student_id !== ctx.viewer.userId) {
      throw scopedNotFound('Submission');
    }

    // Idempotency: if this submission already has an OPEN (IN_REVIEW) regrade
    // request for this student, return it instead of enqueuing a second run. A
    // slow `request_regrade` run can materialize the RegradeRequest only AFTER
    // the 60s client poll below times out; a client retry would then create a
    // duplicate IN_REVIEW row and a duplicate grader email. This GRA is always
    // an individual submission (team repos were rejected above, student_id set),
    // so an open request on it belongs to this student — the student_id check is
    // defense-in-depth against a shared GRA.
    const existing = await ClassmojiService.regradeRequest.findOpenByAssignmentId(gra.id);
    if (existing && existing.student_id === ctx.viewer.userId) {
      return ok({
        success: true,
        regrade_request: {
          id: existing.id,
          status: existing.status,
          previous_grade: existing.previous_grade,
        },
      });
    }

    // Build the previous_grade snapshot from the DB — exactly as the route does.
    const previousGrade = gra.grades.map(g => g.emoji);

    // Same task + payload as the web action (post payload-key fix): the task's
    // run() is regradeRequest.create; onSuccess emails the assigned graders.
    // Known limitation: the 60s wait below is a client-side timeout, NOT a
    // cancel — a run that finishes after it still creates the request (the
    // idempotency guard above absorbs the resulting retry).
    const run = await tasks.trigger('request_regrade', {
      classroom_id: classroom.classroomId,
      gitRepoAssignment: gra,
      student_id: ctx.viewer.userId,
      student_comment: args.comment,
      previous_grade: previousGrade,
    });
    const output = (await waitForRunCompletion(run.id)) as {
      id?: string;
      status?: string;
      previous_grade?: string[];
    } | null;

    // The run returns the created RegradeRequest; fall back to the DB if the
    // output was not materialized in the retrieve response.
    let request = output && output.id ? output : null;
    if (!request) {
      const candidates = await ClassmojiService.regradeRequest.findMany({
        git_repo_assignment_id: gra.id,
        student_id: ctx.viewer.userId,
      });
      const newest = [...candidates].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0];
      if (!newest) {
        throw new ToolError('internal', 'Regrade request was not created');
      }
      request = { id: newest.id, status: newest.status, previous_grade: newest.previous_grade };
    }

    await writeAudit(ctx, {
      resource_type: 'REGRADE_REQUEST',
      resource_id: request.id,
      action: 'CREATE',
      data: { tool: 'regrade_create', git_repo_assignment_id: gra.id },
    });

    return ok({
      success: true,
      regrade_request: {
        id: request.id,
        status: request.status,
        previous_grade: request.previous_grade,
      },
    });
  },
};

interface RegradeResolveArgs {
  classroom: string;
  regrade_request_id: string;
  resolution: 'APPROVED' | 'DENIED';
  emoji?: string;
  comment?: string;
}

/** regrade_resolve on a quiz request: the service writes and audits; the task emails. */
async function resolveQuizRegrade(
  request: Awaited<ReturnType<typeof loadRegradeRequestInClassroom>>,
  args: RegradeResolveArgs,
  ctx: ToolContext
) {
  const { classroomId } = requireClassroomCtx(ctx);
  const comment = args.comment?.trim() ?? '';
  if (!comment) {
    throw new ToolError('invalid_params', 'A quiz regrade needs a reply to the student (comment)');
  }
  if (args.resolution === 'APPROVED' && args.emoji === undefined) {
    throw new ToolError(
      'invalid_params',
      "APPROVED on a quiz request needs emoji: the new grade, on the classroom's scale"
    );
  }
  if (args.resolution === 'DENIED' && args.emoji !== undefined) {
    throw new ToolError('invalid_params', 'DENIED keeps the grade: give no emoji');
  }

  let result: Awaited<ReturnType<typeof ClassmojiService.regradeRequest.resolveQuiz>>;
  try {
    result = await ClassmojiService.regradeRequest.resolveQuiz({
      requestId: request.id,
      resolution: args.resolution,
      ...(args.emoji !== undefined ? { emoji: args.emoji } : {}),
      comment,
      actorUserId: ctx.viewer.userId,
      tool: 'regrade_resolve',
      impersonatedBy: ctx.viewer.impersonatedBy ?? null,
    });
  } catch (error) {
    throw mapQuizGradeError(error, 'Regrade request');
  }
  if (result.classroomId !== classroomId) throw scopedNotFound('Regrade request');

  // The email reads the resolved request from the database. The resolution is
  // already written, so a failed enqueue is reported, not thrown.
  let emailQueued = false;
  if (!result.alreadyResolved) {
    try {
      await tasks.trigger('quiz_regrade_resolved', { request_id: request.id });
      emailQueued = true;
    } catch (error) {
      console.error('[mcp regrade_resolve] resolution email enqueue failed', {
        requestId: request.id,
        error,
      });
    }
  }

  const attempt = request.quiz_attempt;
  return ok({
    success: true,
    ...(result.alreadyResolved ? { already_resolved: true } : { email_queued: emailQueued }),
    regrade_request: {
      id: result.request.id,
      status: result.request.status,
      target: 'quiz',
      grader_comment: result.request.grader_comment ?? null,
      previous_grade: result.request.previous_grade,
      quiz: {
        quiz_id: result.quiz.id,
        quiz_name: result.quiz.name,
        attempt_id: result.attempt.id,
        attempt_number: attempt?.attempt_number ?? null,
      },
    },
    // The attempt's grade now: emoji only (E6).
    attempt_grade: {
      grade_emoji: result.grade.effective.emoji,
      original_emoji: result.grade.original.emoji,
      adjusted: result.grade.adjusted,
    },
  });
}

export const regradeResolveTool: ToolDefinition<RegradeResolveArgs> = {
  name: 'regrade_resolve',
  annotations: { destructive: true, idempotent: true, openWorld: false },
  title: 'Resolve a regrade request',
  description:
    'Resolves a pending regrade request (APPROVED or DENIED) and emails the student. comment ' +
    'is your reply, which the student reads (required for a quiz request). A submission ' +
    'request: after approving, add the new grade with grade_add; it replaces the pre-request ' +
    'grades rather than averaging with them. A quiz request (target quiz in ' +
    'list_regrade_requests): APPROVED needs emoji, the new grade on the classroom scale ' +
    "(emoji_scale from grading_report or list_submissions), which becomes the attempt's " +
    'grade ("Score adjusted"); ' +
    'DENIED keeps the grade ("Score kept"). Grades come back as emoji only. A request ' +
    'already resolved is returned unchanged (already_resolved). Teaching team; audited.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    regrade_request_id: z.string().uuid().describe('RegradeRequest id'),
    resolution: z.enum(['APPROVED', 'DENIED']).describe('The resolution status'),
    emoji: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Quiz requests, APPROVED only: the new grade, an emoji on the classroom's scale"),
    comment: z
      .string()
      .max(5000)
      .optional()
      .describe('Your reply to the student (required for quiz requests)'),
  },
  handler: async (args, ctx) => {
    const request = await loadRegradeRequestInClassroom(args.regrade_request_id, ctx);
    if (request.quiz_attempt_id) {
      return resolveQuizRegrade(request, args, ctx);
    }
    if (args.emoji !== undefined) {
      throw new ToolError(
        'invalid_params',
        'emoji is for quiz requests; add a submission grade with grade_add'
      );
    }
    const reply = args.comment?.trim() || null;

    // Idempotency (U11): waitForRunCompletion below is a 60s client-side
    // timeout, not a cancel — the update_regrade_request run can flip the row
    // and email the student AFTER the MCP request has timed out. A client retry
    // would re-trigger the task and send a SECOND resolution email. Once the
    // request leaves IN_REVIEW it is terminal, so return its recorded
    // resolution without re-triggering. (Mirrors regrade_create's F1 guard.)
    if (request.status !== 'IN_REVIEW') {
      return ok({
        success: true,
        regrade_request: { id: request.id, status: request.status },
        already_resolved: true,
      });
    }

    // Same task + payload as api.$operation updateRegradeRequest: the status
    // update and the resolution email use values re-derived from the DB
    // record, never the request body. onSuccess emails the student.
    const run = await tasks.trigger('update_regrade_request', {
      request: {
        id: request.id,
        student: {
          email: request.student?.email,
        },
        git_repo_assignment: {
          assignment: {
            title: request.git_repo_assignment?.assignment?.title,
          },
        },
      },
      data: {
        status: args.resolution,
        // The reply the student reads, when one is given.
        ...(reply ? { grader_comment: reply } : {}),
      },
    });
    await waitForRunCompletion(run.id);

    await writeAudit(ctx, {
      resource_type: 'REGRADE_REQUEST',
      resource_id: request.id,
      action: 'UPDATE',
      data: { tool: 'regrade_resolve', resolution: args.resolution, comment_set: reply !== null },
    });

    return ok({
      success: true,
      regrade_request: { id: request.id, status: args.resolution },
    });
  },
};
