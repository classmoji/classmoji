/**
 * assignment_update — deadline / weight / grades_released / grader_deadline /
 * release_at.
 *
 * Route-derived per-field tiers (plan §4.2, verified in the tree):
 *   - general edits (weight, …):   OWNER only (admin.$class.assignments
 *                                  `update` → requireClassroomAdmin →
 *                                  assignment.updateInClassroom)
 *   - grader_deadline, release_at: OWNER only, same route — the only web
 *                                  route that edits either field on an existing
 *                                  assignment (classroom import copies/strips
 *                                  them at create time). AssignmentFormModal
 *                                  always posts to /admin/…/assignments?/update,
 *                                  even when opened from the /teacher detail
 *                                  page. An empty picker sends null, so both
 *                                  are clearable; no ordering rule between the
 *                                  dates is enforced anywhere.
 *   - grades_released flip:        OWNER + TEACHER (api.gitRepoAssignment.$class
 *                                  updateGradeRelease → ['OWNER','TEACHER'])
 *   - student_deadline move:       OWNER + TEACHER (admin.$class.calendar
 *                                  update_deadline → isAdmin = OWNER/TEACHER)
 * The tool declares ['OWNER','TEACHER'] and enforces the OWNER-only fields
 * in-handler.
 *
 * Backbone: ClassmojiService.assignment.update — the NOTIFYING path (fires
 * ASSIGNMENT_DUE_DATE_CHANGED on deadline change and ASSIGNMENT_GRADED on a
 * false→true grades_released flip). Never assignment.releaseGrades, which is
 * the same DB write with the notification silently skipped (plan §5.2 gap 7).
 * updateInClassroom (the web path for the date fields) runs the same
 * notifyAfterUpdate, which ignores grader_deadline and release_at: neither
 * schedules anything on write. release_at is read later by the nightly
 * release cron (findReadyForRelease), the repo-provisioning filter, and the
 * student "locked" view; a null release_at is never auto-released.
 */

import { ClassmojiService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  holdsRole,
  loadAssignmentInClassroom,
  loadRepositoryInClassroom,
  ok,
  OWNER_ONLY,
  OWNER_TEACHER,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

/** Prisma unique-violation (P2002) — Assignment is @@unique([repository_id, title]). */
function isUniqueTitleViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002';
}

interface AssignmentUpdateArgs {
  classroom: string;
  assignment_id: string;
  student_deadline?: string;
  weight?: number;
  grades_released?: boolean;
  grader_deadline?: string | null;
  release_at?: string | null;
}

/** Fields a TEACHER (non-OWNER) may update, per the web routes above. */
const TEACHER_ALLOWED_FIELDS = new Set(['grades_released', 'student_deadline']);

export const assignmentUpdateTool: ToolDefinition<AssignmentUpdateArgs> = {
  name: 'assignment_update',
  annotations: { destructive: false },
  title: 'Update an assignment',
  description:
    'Updates an assignment (a due-dated, gradeable slice of a repo/lab): student_deadline, ' +
    'weight, grades_released, grader_deadline, and/or release_at. Owners can update all ' +
    'fields; teachers only grades_released and student_deadline. Releasing grades notifies ' +
    'graded students; moving the student deadline notifies affected students. release_at is ' +
    'when an unpublished assignment auto-releases to students (checked nightly). Pass null ' +
    'to clear grader_deadline or release_at; a cleared release_at never auto-releases.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    assignment_id: z.string().uuid().describe('Assignment id'),
    student_deadline: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('New student deadline (ISO 8601, e.g. 2026-07-20T23:59:00-04:00)'),
    weight: z.number().positive().max(10000).optional().describe('Grading weight'),
    grades_released: z
      .boolean()
      .optional()
      .describe('Whether grades for this assignment are visible to students'),
    // Nullable, unlike on assignment_create: the web edit form clears either
    // date by sending null (AssignmentFormModal toIso → updateInClassroom).
    grader_deadline: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('Grader due date (ISO 8601); null clears it. Owner only'),
    release_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('Auto-release date (ISO 8601); null clears it. Owner only'),
  },
  handler: async (args, ctx) => {
    const updates: Prisma.AssignmentUpdateInput = {};
    // The new value of each changed field for the audit row, as the web
    // calendar's deadline move records its new_deadline. Dates as ISO strings,
    // cleared dates as null.
    const values: Record<string, string | number | boolean | null> = {};
    const toDate = (iso: string | null) => (iso === null ? null : new Date(iso));
    const setDate = (
      field: 'student_deadline' | 'grader_deadline' | 'release_at',
      iso: string | null
    ) => {
      const date = toDate(iso);
      updates[field] = date;
      values[field] = date?.toISOString() ?? null;
    };
    if (args.student_deadline !== undefined) setDate('student_deadline', args.student_deadline);
    if (args.weight !== undefined) updates.weight = values.weight = args.weight;
    if (args.grades_released !== undefined) {
      updates.grades_released = values.grades_released = args.grades_released;
    }
    if (args.grader_deadline !== undefined) setDate('grader_deadline', args.grader_deadline);
    if (args.release_at !== undefined) setDate('release_at', args.release_at);

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one of: student_deadline, weight, grades_released, grader_deadline, release_at'
      );
    }

    // Per-field tier: OWNER-only fields need an OWNER membership (checked via
    // holdsRole so a multi-role OWNER whose gate resolved as TEACHER passes).
    const ownerOnlyFields = fields.filter(f => !TEACHER_ALLOWED_FIELDS.has(f));
    if (ownerOnlyFields.length > 0 && !(await holdsRole(ctx, ['OWNER']))) {
      throw new ToolError(
        'forbidden',
        `Only the classroom owner can update: ${ownerOnlyFields.join(', ')}`,
        'INSUFFICIENT_ROLE'
      );
    }

    const assignment = await loadAssignmentInClassroom(args.assignment_id, ctx);
    const updated = await ClassmojiService.assignment.update(assignment.id, updates);

    await writeAudit(ctx, {
      resource_type: 'ASSIGNMENT',
      resource_id: assignment.id,
      action: 'UPDATE',
      // `value` is what keeps two different edits inside audit's 5s dedup window
      // from collapsing into one row; an identical re-send still dedups.
      data: { tool: 'assignment_update', fields, values, value: JSON.stringify(values) },
    });

    return ok({
      success: true,
      assignment: {
        id: updated.id,
        title: updated.title,
        student_deadline: updated.student_deadline?.toISOString() ?? null,
        weight: updated.weight,
        grades_released: updated.grades_released,
        grader_deadline: updated.grader_deadline?.toISOString() ?? null,
        release_at: updated.release_at?.toISOString() ?? null,
      },
    });
  },
};

interface AssignmentCreateArgs {
  classroom: string;
  module_id: string;
  repository_id: string;
  submission_mode?: 'ISSUE' | 'REPO';
  title: string;
  weight?: number;
  is_extra_credit?: boolean;
  description?: string;
  student_deadline?: string;
  grader_deadline?: string;
  tokens_per_hour?: number;
  release_at?: string;
  is_published?: boolean;
}

export const assignmentCreateTool: ToolDefinition<AssignmentCreateArgs> = {
  name: 'assignment_create',
  annotations: { destructive: false },
  title: 'Create an assignment',
  description:
    'Creates a REPO assignment (due-dated, gradeable) in a module, submitting through an ' +
    'existing repository (see list_repos). submission_mode REPO (default): the last push to the ' +
    'student repo before the deadline is the submission, no issue is opened. ISSUE: Classmoji opens a GitHub issue in each ' +
    'student repo and closing it submits. Owner only. Creating it does NOT provision anything on ' +
    'GitHub — the assignment reaches students only when its repo is published (repo_publish) or ' +
    'the next release runs. Created as a draft unless is_published is set.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module the assignment belongs to (see list_modules)'),
    repository_id: z
      .string()
      .uuid()
      .describe('Repository students submit through (see list_repos)'),
    submission_mode: z
      .enum(['ISSUE', 'REPO'])
      .optional()
      .describe('REPO (default): a push submits. ISSUE: closing a GitHub issue submits.'),
    title: z.string().min(1).max(200).describe('Assignment title (unique per repository)'),
    weight: z.number().positive().max(10000).optional().describe('Grading weight (default 100)'),
    is_extra_credit: z
      .boolean()
      .optional()
      .describe('Extra credit: adds to the course grade without adding to its denominator'),
    description: z.string().max(10000).optional(),
    student_deadline: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Student due date (ISO 8601, e.g. 2026-07-20T23:59:00-04:00)'),
    grader_deadline: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Grader due date (ISO 8601)'),
    tokens_per_hour: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Extension token cost per late hour (default 0)'),
    release_at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Auto-release date (ISO 8601)'),
    is_published: z.boolean().optional().describe('Publish immediately (default false = draft)'),
  },
  handler: async (args, ctx) => {
    // S1: the assignment row does not exist yet, so verify BOTH cross-record
    // references belong to this classroom: the module it lives in and the
    // repository it submits through. Never trust request input for scope.
    const classroom = requireClassroomCtx(ctx);
    const module = await ClassmojiService.module.findById(args.module_id);
    if (!module || module.classroom_id !== classroom.classroomId) {
      throw scopedNotFound('Module');
    }
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);

    // The tool creates REPO assignments only (quiz/form assignments are a
    // later phase).
    const data: Prisma.AssignmentUncheckedCreateInput = {
      module_id: module.id,
      type: 'REPO',
      submission_mode: args.submission_mode ?? 'REPO',
      repository_id: repository.id,
      title: args.title,
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.is_extra_credit !== undefined ? { is_extra_credit: args.is_extra_credit } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.student_deadline !== undefined
        ? { student_deadline: new Date(args.student_deadline) }
        : {}),
      ...(args.grader_deadline !== undefined
        ? { grader_deadline: new Date(args.grader_deadline) }
        : {}),
      ...(args.tokens_per_hour !== undefined ? { tokens_per_hour: args.tokens_per_hour } : {}),
      ...(args.release_at !== undefined ? { release_at: new Date(args.release_at) } : {}),
      ...(args.is_published !== undefined ? { is_published: args.is_published } : {}),
    };

    let created;
    try {
      created = await ClassmojiService.assignment.create(data);
    } catch (error) {
      if (isUniqueTitleViolation(error)) {
        throw new ToolError(
          'invalid_params',
          'An assignment with this title already exists in this repository.'
        );
      }
      throw error;
    }

    await writeAudit(ctx, {
      resource_type: 'ASSIGNMENT',
      resource_id: created.id,
      action: 'CREATE',
      data: {
        tool: 'assignment_create',
        repository_id: repository.id,
        title: args.title,
        submission_mode: args.submission_mode ?? 'REPO',
      },
    });

    return ok({
      success: true,
      assignment: {
        id: created.id,
        title: created.title,
        module_id: created.module_id,
        type: created.type,
        submission_mode: created.submission_mode,
        repository_id: created.repository_id,
        weight: created.weight,
        is_extra_credit: created.is_extra_credit,
        is_published: created.is_published,
        student_deadline: created.student_deadline?.toISOString() ?? null,
      },
    });
  },
};

interface AssignmentDeleteArgs {
  classroom: string;
  assignment_id: string;
}

export const assignmentDeleteTool: ToolDefinition<AssignmentDeleteArgs> = {
  name: 'assignment_delete',
  annotations: { destructive: true },
  title: 'Delete an assignment',
  description:
    'Permanently deletes an assignment. Owner only. THIS CANNOT BE UNDONE and cascades: it ' +
    'deletes every student/team submission for this assignment along with all their grades, ' +
    'grader assignments, regrade requests, token transactions, and analytics, plus its ' +
    'page/slide/calendar links. For an ISSUE-mode assignment it does NOT remove the GitHub issues ' +
    'already created in student repos (they are orphaned), and it does NOT reconcile student ' +
    'token balances.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    assignment_id: z.string().uuid().describe('Assignment id'),
  },
  handler: async (args, ctx) => {
    const assignment = await loadAssignmentInClassroom(args.assignment_id, ctx);
    // Blast-radius count for the audit trail (findById includes the submissions).
    const submissionsDeleted = assignment.git_repo_assignments?.length ?? 0;

    await ClassmojiService.assignment.deleteById(assignment.id);

    await writeAudit(ctx, {
      resource_type: 'ASSIGNMENT',
      resource_id: assignment.id,
      action: 'DELETE',
      data: {
        tool: 'assignment_delete',
        title: assignment.title,
        submissions_deleted: submissionsDeleted,
      },
    });

    return ok({
      success: true,
      deleted_assignment_id: assignment.id,
      submissions_deleted: submissionsDeleted,
    });
  },
};
