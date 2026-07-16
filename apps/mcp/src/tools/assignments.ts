/**
 * assignment_update — deadline / weight / grades_released.
 *
 * Route-derived per-field tiers (plan §4.2, verified in the tree):
 *   - general edits (weight, …):   OWNER only (admin.$class.repos_.$title.update
 *                                  → requireClassroomAdmin)
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
 */

import { ClassmojiService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { holdsRole, loadAssignmentInClassroom, ok, OWNER_TEACHER, writeAudit } from './shared.ts';

interface AssignmentUpdateArgs {
  classroom: string;
  assignment_id: string;
  student_deadline?: string;
  weight?: number;
  grades_released?: boolean;
}

/** Fields a TEACHER (non-OWNER) may update, per the web routes above. */
const TEACHER_ALLOWED_FIELDS = new Set(['grades_released', 'student_deadline']);

export const assignmentUpdateTool: ToolDefinition<AssignmentUpdateArgs> = {
  name: 'assignment_update',
  annotations: { destructive: false },
  title: 'Update an assignment',
  description:
    'Updates an assignment (a due-dated, gradeable slice of a repo/lab): student deadline, ' +
    'weight, and/or grades_released. Owners can update all fields; teachers only ' +
    'grades_released and student_deadline. Releasing grades notifies graded students; moving ' +
    'the deadline notifies affected students.',
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
    weight: z.number().int().positive().max(10000).optional().describe('Grading weight'),
    grades_released: z
      .boolean()
      .optional()
      .describe('Whether grades for this assignment are visible to students'),
  },
  handler: async (args, ctx) => {
    const updates: Prisma.AssignmentUpdateInput = {};
    if (args.student_deadline !== undefined) {
      updates.student_deadline = new Date(args.student_deadline);
    }
    if (args.weight !== undefined) updates.weight = args.weight;
    if (args.grades_released !== undefined) updates.grades_released = args.grades_released;

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one of: student_deadline, weight, grades_released'
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
      data: { tool: 'assignment_update', fields },
    });

    return ok({
      success: true,
      assignment: {
        id: updated.id,
        title: updated.title,
        student_deadline: updated.student_deadline?.toISOString() ?? null,
        weight: updated.weight,
        grades_released: updated.grades_released,
      },
    });
  },
};
