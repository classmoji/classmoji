/**
 * Grader assignment tools — grader_assign / grader_unassign.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.repos_.$title/action.ts and
 * admin.$class.assignments_.$id (addGrader / removeGrader) and
 * .assign-graders (bulk), all gated by requireClassroomAdmin — OWNER only.
 * `roles` is who may CALL the tool; who may BE a grader is a separate rule.
 *
 * Backbone: HelperService.addGraderInClassroom / removeGraderInClassroom, the
 * same classroom-scoped helpers the web actions call, so both surfaces apply
 * one rule:
 *   - the submission is loaded from THIS classroom (gitRepoAssignment
 *     .findByIdInClassroom); a missing or foreign one is `submission_not_found`;
 *   - the grader must be in the classroom's grader pool
 *     (gitRepoAssignmentGrader.findEligibleGrader): an ASSISTANT or TEACHER
 *     membership with is_grader=true, and a stored login. An OWNER, or staff
 *     without is_grader, is `grader_not_eligible`;
 *   - the repo name, issue number and login come from stored rows, never the
 *     request;
 *   - removal takes the grader from the submission's own grader rows, so
 *     someone who has since left the pool can still be removed.
 * The submission check runs before the eligibility check, so a foreign
 * submission id gets the same not_found whoever is named as grader.
 *
 * ⚠ EXTERNAL SIDE EFFECT / FAILURE MODE: the helper `await`s the GitHub
 * assignee call BEFORE the DB write with no try/catch, so a GitHub failure
 * aborts the whole operation — it fails CLOSED with no partial DB state. A
 * submission with no issue number (REPO mode) skips GitHub entirely.
 */

import { AssignGradersError, ClassmojiService, HelperService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadAssignmentInClassroom,
  ok,
  OWNER_ONLY,
  requireClassroomCtx,
  scopedNotFound,
  submissionIdSchema,
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

/** The eligibility rule, worded for the caller (grader_not_eligible). */
export const GRADER_NOT_ELIGIBLE_MESSAGE =
  'That person cannot be a grader here: a grader must be an ASSISTANT or TEACHER in this ' +
  'classroom marked as a grader (is_grader). staff_update can set is_grader.';

export const graderAssignTool: ToolDefinition<GraderArgs> = {
  name: 'grader_assign',
  annotations: { destructive: false, openWorld: true },
  title: 'Assign a grader',
  description:
    'Assigns a grader to one submission and mirrors them onto the GitHub issue assignees, like ' +
    'the web repository and assignment pages. Owner only. The grader must be an ASSISTANT or ' +
    'TEACHER of this classroom marked as a grader (is_grader) — an owner, or staff without ' +
    'is_grader, is refused; staff_update sets is_grader. git_repo_assignment_id is the `id` from ' +
    'list_submissions; grader_id is a user id from list_teaching_team. Assigning someone already ' +
    'on the submission changes nothing and returns already_assigned: true.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema.describe('Submission (GitRepoAssignment) id'),
    grader_id: z
      .string()
      .uuid()
      .describe('User id of the grader (an ASSISTANT or TEACHER with is_grader)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gitOrganization = await loadGitOrganization(classroom.classroomId);

    const result = await HelperService.addGraderInClassroom({
      classroomId: classroom.classroomId,
      gitOrganization,
      gitRepoAssignmentId: args.git_repo_assignment_id,
      graderId: args.grader_id,
    });

    switch (result.status) {
      case 'submission_not_found':
        throw scopedNotFound('Submission');
      case 'grader_not_eligible':
        throw new ToolError('invalid_params', GRADER_NOT_ELIGIBLE_MESSAGE);
      case 'already_assigned':
        // Nothing was written, so nothing is audited.
        return ok({
          success: true,
          already_assigned: true,
          grader: result.graderLogin,
          git_repo_assignment_id: args.git_repo_assignment_id,
        });
    }

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
      resource_id: args.git_repo_assignment_id,
      action: 'CREATE',
      data: {
        tool: 'grader_assign',
        // `value` joins the audit service's 5s dedup key: assigning two
        // different graders to one submission must leave two rows.
        value: args.grader_id,
        grader_id: args.grader_id,
        grader_login: result.graderLogin,
      },
    });

    return ok({
      success: true,
      grader: result.graderLogin,
      git_repo_assignment_id: args.git_repo_assignment_id,
    });
  },
};

export const graderUnassignTool: ToolDefinition<GraderArgs> = {
  name: 'grader_unassign',
  annotations: { destructive: true, openWorld: true },
  title: 'Unassign a grader',
  description:
    'Removes a grader from one submission and from the GitHub issue assignees, like the web ' +
    'repository and assignment pages. Owner only. The grader must currently be assigned to the ' +
    'submission; anyone assigned can be removed, even if they are no longer marked as a grader. ' +
    'git_repo_assignment_id is the `id` from list_submissions.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema.describe('Submission (GitRepoAssignment) id'),
    grader_id: z.string().uuid().describe('User id of the currently assigned grader'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gitOrganization = await loadGitOrganization(classroom.classroomId);

    const result = await HelperService.removeGraderInClassroom({
      classroomId: classroom.classroomId,
      gitOrganization,
      gitRepoAssignmentId: args.git_repo_assignment_id,
      graderId: args.grader_id,
    });

    switch (result.status) {
      case 'submission_not_found':
        throw scopedNotFound('Submission');
      case 'grader_not_assigned':
        throw new ToolError(
          'invalid_params',
          'That person is not assigned as a grader on this submission'
        );
    }

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
      resource_id: args.git_repo_assignment_id,
      action: 'DELETE',
      data: {
        tool: 'grader_unassign',
        value: args.grader_id,
        grader_id: args.grader_id,
        grader_login: result.graderLogin,
      },
    });

    return ok({ success: true, removed_grader: result.graderLogin });
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
