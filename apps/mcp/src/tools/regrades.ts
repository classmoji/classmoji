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
 */

import { ClassmojiService } from '@classmoji/services';
import { runs, tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadGitRepoAssignmentInClassroom,
  loadRegradeRequestInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

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
  git_repo_assignment_id: string;
  comment: string;
}

export const regradeCreateTool: ToolDefinition<RegradeCreateArgs> = {
  name: 'regrade_create',
  annotations: { destructive: false },
  title: 'Request a regrade',
  description:
    'Submits a regrade (resubmit) request for one of YOUR OWN graded submissions. Students ' +
    'only. Snapshots the current grades as the previous grade and notifies the assigned ' +
    'graders (in-app and by email).',
  scope: 'write',
  roles: ['STUDENT'],
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Your submission (GitRepoAssignment) id'),
    comment: z.string().min(1).max(2000).describe('Why the work should be regraded'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);

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
}

export const regradeResolveTool: ToolDefinition<RegradeResolveArgs> = {
  name: 'regrade_resolve',
  annotations: { destructive: false },
  title: 'Resolve a regrade request',
  description:
    'Approves or denies a pending regrade request and emails the student. After approving, add ' +
    'the new grade with grade_add — it will replace the pre-request grades rather than average ' +
    'with them.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    regrade_request_id: z.string().uuid().describe('RegradeRequest id'),
    resolution: z.enum(['APPROVED', 'DENIED']).describe('The resolution status'),
  },
  handler: async (args, ctx) => {
    const request = await loadRegradeRequestInClassroom(args.regrade_request_id, ctx);

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
      },
    });
    await waitForRunCompletion(run.id);

    await writeAudit(ctx, {
      resource_type: 'REGRADE_REQUEST',
      resource_id: request.id,
      action: 'UPDATE',
      data: { tool: 'regrade_resolve', resolution: args.resolution },
    });

    return ok({
      success: true,
      regrade_request: { id: request.id, status: args.resolution },
    });
  },
};
