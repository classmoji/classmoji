/**
 * Grader assignment tools — grader_assign / grader_unassign.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.repos_.$title/action.ts (addGrader /
 * removeGrader) and .assign-graders (bulk), BOTH gated by
 * requireClassroomAdmin — OWNER only. Plan §6 guessed "teaching-team
 * (confirm)"; the routes win (plan §0), so these tools are OWNER-only.
 *
 * Backbone: HelperService.addGraderToGitRepoAssignment /
 * removeGraderFromGitRepoAssignment — these mirror the grader to the GitHub
 * issue assignees AND the DB row; the bare gitRepoAssignmentGrader service
 * would skip the GitHub mirror (plan §5.1).
 *
 * ⚠ EXTERNAL SIDE EFFECT / FAILURE MODE (code-read finding): the Helper
 * `await`s the GitHub call BEFORE the DB write with no try/catch, so a GitHub
 * failure (e.g. fake seeded repos, revoked app permissions) aborts the whole
 * operation — it fails CLOSED with no partial DB state, but it also means
 * grader assignment is impossible while GitHub is unreachable. These tools are
 * therefore verified by code-read + typecheck only against seeded (fake) repos.
 *
 * S1: the submission is loaded and classroom-verified; the grader's GitHub
 * login is derived from the DB user row (never the request); the grader must
 * hold a teaching-team membership in THIS classroom.
 */

import { AssignGradersError, ClassmojiService, HelperService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadAssignmentInClassroom,
  loadGitRepoAssignmentInClassroom,
  ok,
  OWNER_ONLY,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

interface GraderArgs {
  classroom: string;
  git_repo_assignment_id: string;
  grader_id: string;
}

/** Load the raw classroom (with git_organization) for the GitHub mirror call. */
async function loadGitOrganization(classroomId: string) {
  const classroom = await ClassmojiService.classroom.findById(classroomId);
  const gitOrganization = classroom?.git_organization;
  if (!gitOrganization) {
    throw new ToolError('internal', 'Classroom has no linked git organization');
  }
  return gitOrganization;
}

export const graderAssignTool: ToolDefinition<GraderArgs> = {
  name: 'grader_assign',
  annotations: { destructive: false, openWorld: true },
  title: 'Assign a grader',
  description:
    'Assigns a teaching-team member as grader on a submission. Mirrors the grader to the ' +
    'GitHub issue assignees. Owner only (matches the web admin repo view).',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
    grader_id: z.string().uuid().describe('User id of the grader (must be teaching team)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);

    // The grader must be a teaching-team member of THIS classroom; their
    // GitHub login comes from the DB row, never the request.
    const graderMembership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.classroomId,
      args.grader_id,
      ['OWNER', 'TEACHER', 'ASSISTANT']
    );
    const grader = graderMembership?.user;
    if (!grader?.login) {
      throw scopedNotFound('Grader (teaching-team member)');
    }

    if (gra.graders.some(g => g.grader_id === grader.id)) {
      return ok({ success: true, already_assigned: true, grader: grader.login });
    }

    const gitOrganization = await loadGitOrganization(classroom.classroomId);
    await HelperService.addGraderToGitRepoAssignment({
      repoName: gra.git_repo.name,
      gitOrganization,
      githubIssueNumber: gra.provider_issue_number,
      graderLogin: grader.login,
      graderId: grader.id,
      gitRepoAssignmentId: gra.id,
    });

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
      resource_id: gra.id,
      action: 'CREATE',
      data: { tool: 'grader_assign', grader_id: grader.id, grader_login: grader.login },
    });

    return ok({ success: true, grader: grader.login, git_repo_assignment_id: gra.id });
  },
};

export const graderUnassignTool: ToolDefinition<GraderArgs> = {
  name: 'grader_unassign',
  annotations: { destructive: true, openWorld: true },
  title: 'Unassign a grader',
  description:
    'Removes a grader from a submission and from the GitHub issue assignees. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
    grader_id: z.string().uuid().describe('User id of the currently assigned grader'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);

    // Derive the grader from the EXISTING assignment row (works even if the
    // user has since left the classroom).
    const assigned = gra.graders.find(g => g.grader_id === args.grader_id);
    if (!assigned?.grader?.login) {
      throw scopedNotFound('Grader assignment');
    }

    const gitOrganization = await loadGitOrganization(classroom.classroomId);
    await HelperService.removeGraderFromGitRepoAssignment({
      repoName: gra.git_repo.name,
      gitOrganization,
      githubIssueNumber: gra.provider_issue_number,
      graderLogin: assigned.grader.login,
      graderId: assigned.grader_id,
      gitRepoAssignmentId: gra.id,
    });

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
      resource_id: gra.id,
      action: 'DELETE',
      data: {
        tool: 'grader_unassign',
        grader_id: assigned.grader_id,
        grader_login: assigned.grader.login,
      },
    });

    return ok({ success: true, removed_grader: assigned.grader.login });
  },
};

// ─── Bulk grader assignment ──────────────────────────────────────────────────

interface GraderAssignBulkArgs {
  classroom: string;
  assignment_id: string;
  method: 'RANDOM' | 'EXISTING';
  template_assignment_id?: string;
}

export const graderAssignBulkTool: ToolDefinition<GraderAssignBulkArgs> = {
  name: 'grader_assign_bulk',
  // Fans out GitHub issue-assignee writes (openWorld). Adds grader rows only —
  // existing assignments are not cleared, so nothing is destroyed.
  annotations: { destructive: false, openWorld: true },
  title: 'Bulk-assign graders to an assignment',
  description:
    'Distributes graders across ALL submissions of one assignment at once. Owner only. ' +
    "method=RANDOM shuffles the classroom's assistants and teachers that have is_grader set and " +
    'walks them round-robin, so the load is spread evenly and each submission gets exactly one ' +
    'grader. ' +
    'method=EXISTING copies the per-student/per-team grader mapping from template_assignment_id ' +
    '(required for EXISTING, and it must be an assignment in this classroom) — submissions with ' +
    'no match in the template are skipped. Graders are mirrored onto the GitHub issue assignees. ' +
    'Runs in the background; `submissions_assigned` is the number of grader-assignment tasks ' +
    'queued, so with a multi-grader template it can exceed the submission count. Assignment ids ' +
    'come from list_repos. For one-off changes use grader_assign / grader_unassign instead.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    assignment_id: z.string().uuid().describe('Assignment whose submissions get graders'),
    method: z
      .enum(['RANDOM', 'EXISTING'])
      .describe(
        'RANDOM = even round-robin over is_grader assistants and teachers; EXISTING = copy the grader mapping from template_assignment_id'
      ),
    template_assignment_id: z
      .string()
      .uuid()
      .optional()
      .describe('Assignment to copy grader assignments from (required when method=EXISTING)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Cheapest checks first — no lookups needed to know these are unusable.
    if (args.method === 'EXISTING' && !args.template_assignment_id) {
      throw new ToolError(
        'invalid_params',
        'template_assignment_id is required when method is EXISTING'
      );
    }
    // Copying an assignment's grader mapping onto itself is a no-op at best;
    // the web UI filters the target out of the template list for the same reason.
    if (args.method === 'EXISTING' && args.template_assignment_id === args.assignment_id) {
      throw new ToolError(
        'invalid_params',
        'template_assignment_id must be a different assignment than assignment_id'
      );
    }

    // S1 — resolve BOTH assignments through repository.classroom_id before the
    // service runs. This is load-bearing, not belt-and-braces: the service
    // fetches submissions by (assignmentId, classroomSlug), so a foreign or
    // unknown assignment would silently yield zero rows and report "success, 0
    // assigned" instead of not_found. Missing and cross-classroom throw the
    // SAME error, so a probe cannot enumerate another classroom's assignments.
    const assignment = await loadAssignmentInClassroom(args.assignment_id, ctx);
    if (args.template_assignment_id) {
      await loadAssignmentInClassroom(args.template_assignment_id, ctx);
    }

    let result;
    try {
      // classroomId is ALWAYS the authorized classroom. sessionId is omitted:
      // it only exists to tag runs for the web route's progress stream.
      result = await ClassmojiService.gitRepoAssignmentGrader.assignGradersToAssignment({
        classroomId: classroom.classroomId,
        assignmentId: assignment.id,
        method: args.method,
        templateAssignmentId: args.template_assignment_id ?? null,
      });
    } catch (error) {
      if (error instanceof AssignGradersError) {
        if (error.code === 'no_graders') {
          throw new ToolError(
            'invalid_params',
            'No assistants or teachers with is_grader=true in this classroom — flag at least one with staff_update before assigning graders'
          );
        }
        if (error.code === 'template_required') {
          throw new ToolError(
            'invalid_params',
            'template_assignment_id is required when method is EXISTING'
          );
        }
      }
      // classroom_not_found is unreachable (the id comes from a resolved ctx);
      // anything else goes to the registry's generic wrapper.
      throw error;
    }

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
      resource_id: assignment.id,
      action: 'CREATE',
      data: {
        tool: 'grader_assign_bulk',
        assignment_id: assignment.id,
        method: args.method,
        template_assignment_id: args.template_assignment_id ?? null,
        submissions_assigned: result.numAssignmentsToAddGradersTo,
      },
    });

    return ok({
      success: true,
      queued: true,
      submissions_assigned: result.numAssignmentsToAddGradersTo,
      method: args.method,
    });
  },
};
