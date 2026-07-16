/**
 * Grading tools — grade_add / grade_remove / grade_remove_all.
 *
 * Mirrors apps/webapp/app/routes/api.gitRepoAssignment.$class (addGrade /
 * removeGrade): teaching-team INCLUDING TEACHER (['OWNER','TEACHER','ASSISTANT']).
 * grade_remove_all has no web route; per plan §6 it is OWNER-only.
 *
 * ALL grade mutations route through the top-level HelperService orchestrators
 * (plan §5.1): addGradeToGitRepoAssignment handles dedup, regrade-replace
 * (clears pre-regrade grades so a fresh grade replaces rather than averages),
 * and token minting from EmojiMapping.extra_tokens (per-team-member for GROUP
 * repos); removeGradeFromGitRepoAssignment reverses the tokens. Calling the
 * bare assignmentGrade.addGrade/removeGrade would strand the token economy.
 *
 * S1: the target GitRepoAssignment (and, for removals, the grade row) is
 * derived from the DB and verified against the authorized classroom before
 * any mutation. studentId/teamId (the token recipients) come from the DB
 * git_repo row — NEVER from the request.
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
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

interface GradeAddArgs {
  classroom: string;
  git_repo_assignment_id: string;
  emoji: string;
}

/**
 * S9: the emoji must be part of the classroom's grading scale. The web UI
 * constrains this by construction (the grade picker lists mapped emojis);
 * MCP validates explicitly so an AI caller cannot invent junk grades.
 */
async function assertEmojiInScale(classroomId: string, emoji: string): Promise<void> {
  const mappings = (await ClassmojiService.emojiMapping.findByClassroomId(
    classroomId,
    true
  )) as Array<{ emoji: string }>;
  if (!mappings.some(m => m.emoji === emoji)) {
    const valid = mappings.map(m => m.emoji).join(' ');
    throw new ToolError(
      'invalid_params',
      `'${emoji}' is not in this classroom's grading scale. Valid emojis: ${valid || '(none configured)'}`
    );
  }
}

export const gradeAddTool: ToolDefinition<GradeAddArgs> = {
  name: 'grade_add',
  annotations: { destructive: false },
  title: 'Add a grade',
  description:
    'Adds an emoji grade to a submission (a GitRepoAssignment — one assignment on one ' +
    "student/team repo). Use a submission id from the grading queue. The emoji must be in the classroom's " +
    'grading scale. Token rewards from the emoji mapping are minted automatically (per team member ' +
    'for group repos). If the submission has an open regrade request, pre-request grades are ' +
    'replaced rather than averaged.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
    emoji: z.string().min(1).max(16).describe('Emoji grade (must be in the grading scale)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);
    await assertEmojiInScale(classroom.classroomId, args.emoji);

    const priorGrade = gra.grades.find(g => g.emoji === args.emoji);

    await HelperService.addGradeToGitRepoAssignment({
      classroom: { id: classroom.classroomId },
      gitRepoAssignment: { id: gra.id },
      // Grade as the authenticated caller — never a client-supplied graderId.
      graderId: ctx.viewer.userId,
      grade: args.emoji,
      studentId: gra.git_repo.student_id ?? undefined,
      teamId: gra.git_repo.team_id ?? undefined,
    });

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: gra.id,
      action: 'CREATE',
      data: { tool: 'grade_add', emoji: args.emoji },
    });

    const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(gra.id);
    // The orchestrator dedups silently — but on the regrade-replace path it
    // CLEARS the pre-request grade and mints a fresh row for the same emoji,
    // which is a real mutation, not a no-op. Report deduplicated only when the
    // pre-existing grade row itself survived (same id before and after).
    const currentGrade = grades.find(g => g.emoji === args.emoji);
    const deduplicated = Boolean(priorGrade && currentGrade && priorGrade.id === currentGrade.id);
    return ok({
      success: true,
      git_repo_assignment_id: gra.id,
      deduplicated,
      grades: grades.map(g => ({ id: g.id, emoji: g.emoji, grader: g.grader?.login ?? null })),
    });
  },
};

interface GradeRemoveArgs {
  classroom: string;
  git_repo_assignment_id: string;
  grade_id: string;
}

export const gradeRemoveTool: ToolDefinition<GradeRemoveArgs> = {
  name: 'grade_remove',
  annotations: { destructive: true },
  title: 'Remove a grade',
  description:
    'Removes one emoji grade from a submission and reverses any token reward it minted. ' +
    "Get grade ids from grade_add's response or the grading views.",
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
    grade_id: z.string().uuid().describe('AssignmentGrade id to remove'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);

    // The grade must belong to the (classroom-verified) submission — same
    // derivation as the web route's removeGrade.
    const grade = await ClassmojiService.assignmentGrade.findById(args.grade_id);
    if (!grade || grade.git_repo_assignment_id !== gra.id) {
      throw scopedNotFound('Grade');
    }

    await HelperService.removeGradeFromGitRepoAssignment({
      classroom: { id: classroom.classroomId },
      gitRepoAssignment: {
        id: gra.id,
        studentId: gra.git_repo.student_id ?? undefined,
        teamId: gra.git_repo.team_id ?? undefined,
      },
      grade,
    });

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: gra.id,
      action: 'DELETE',
      data: { tool: 'grade_remove', emoji: grade.emoji, grade_id: grade.id },
    });

    return ok({ success: true, removed: { id: grade.id, emoji: grade.emoji } });
  },
};

interface GradeRemoveAllArgs {
  classroom: string;
  git_repo_assignment_id: string;
}

export const gradeRemoveAllTool: ToolDefinition<GradeRemoveAllArgs> = {
  name: 'grade_remove_all',
  annotations: { destructive: true },
  title: 'Remove all grades from a submission',
  description:
    'Removes every emoji grade from a submission and reverses their token rewards. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);

    // findByAssignmentId includes token_transaction — required by the
    // orchestrated removal to reverse tokens. A bare
    // assignmentGrade.removeAllGrades would delete rows but strand tokens.
    const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(gra.id);
    for (const grade of grades) {
      await HelperService.removeGradeFromGitRepoAssignment({
        classroom: { id: classroom.classroomId },
        gitRepoAssignment: {
          id: gra.id,
          studentId: gra.git_repo.student_id ?? undefined,
          teamId: gra.git_repo.team_id ?? undefined,
        },
        grade,
      });
    }

    await writeAudit(ctx, {
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: gra.id,
      action: 'DELETE',
      data: { tool: 'grade_remove_all', removed_count: grades.length },
    });

    return ok({ success: true, removed_count: grades.length });
  },
};
