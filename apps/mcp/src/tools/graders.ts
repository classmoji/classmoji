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

import { ClassmojiService, HelperService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
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
