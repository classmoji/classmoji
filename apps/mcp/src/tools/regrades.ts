/**
 * Regrade tools — regrade_create (student self) / regrade_resolve (teaching team).
 *
 * regrade_create mirrors apps/webapp/app/routes/student.$class.regrade-requests.new:
 * requireStudentAccess (STUDENT only) + the action's IDOR check — the target
 * submission's git_repo.student_id must equal the authenticated user (derived
 * from the DB, never the request). Note: the web action rejects TEAM-owned
 * submissions (student_id is null on a team repo), even though its loader
 * lists team assignments in the dropdown — MCP mirrors the action.
 *
 * The `previous_grade` String[] snapshot is built HERE from the submission's
 * current grades — regradeRequest.create does NOT compute it (plan §5.1).
 * regradeRequest.create fires in-app notifications to the submission's
 * assigned graders. (The web path additionally sends grader emails via the
 * `request_regrade` Trigger.dev task; MCP v1 calls the service directly, so
 * emails are skipped — divergence reported in Phase 2c notes.)
 *
 * regrade_resolve mirrors api.$operation?action=updateRegradeRequest:
 * teaching-team (['OWNER','TEACHER','ASSISTANT']), authorization derived from
 * the RegradeRequest record's classroom. The web wraps the status update in
 * the `update_regrade_request` task whose onSuccess emails the student; MCP
 * v1 performs the same DB update via regradeRequest.update (email skipped —
 * reported). Statuses match the web UI: APPROVED | DENIED.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
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

interface RegradeCreateArgs {
  classroom: string;
  git_repo_assignment_id: string;
  comment: string;
}

export const regradeCreateTool: ToolDefinition<RegradeCreateArgs> = {
  name: 'regrade_create',
  title: 'Request a regrade',
  description:
    'Submits a regrade (resubmit) request for one of YOUR OWN graded submissions. Students ' +
    'only. Snapshots the current grades as the previous grade and notifies the assigned graders.',
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

    // Build the previous_grade snapshot from the DB — the service does not.
    const previousGrade = gra.grades.map(g => g.emoji);

    const request = await ClassmojiService.regradeRequest.create({
      classroom_id: classroom.classroomId,
      git_repo_assignment_id: gra.id,
      student_id: ctx.viewer.userId,
      student_comment: args.comment,
      previous_grade: previousGrade,
    });

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
  title: 'Resolve a regrade request',
  description:
    'Approves or denies a pending regrade request. After approving, add the new grade with ' +
    'grade_add — it will replace the pre-request grades rather than average with them.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    regrade_request_id: z.string().uuid().describe('RegradeRequest id'),
    resolution: z.enum(['APPROVED', 'DENIED']).describe('The resolution status'),
  },
  handler: async (args, ctx) => {
    const request = await loadRegradeRequestInClassroom(args.regrade_request_id, ctx);

    const updated = await ClassmojiService.regradeRequest.update({
      id: request.id,
      data: { status: args.resolution },
    });

    await writeAudit(ctx, {
      resource_type: 'REGRADE_REQUEST',
      resource_id: request.id,
      action: 'UPDATE',
      data: { tool: 'regrade_resolve', resolution: args.resolution },
    });

    return ok({
      success: true,
      regrade_request: { id: updated.id, status: updated.status },
    });
  },
};
