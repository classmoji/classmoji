/**
 * assignment_update — deadline / weight / grades_released / grader_deadline /
 * release_at / closes_at / tokens_per_hour / module_id (the move to another
 * module).
 *
 * Route-derived per-field tiers (plan §4.2, verified in the tree):
 *   - general edits (weight, …):   OWNER only, but see QUIZ below
 *                                  (admin.$class.assignments `update` →
 *                                  requireClassroomAdmin →
 *                                  assignment.updateInClassroom)
 *   - grader_deadline, release_at: OWNER only (release_at: see QUIZ below),
 *                                  same route — the only web
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
 *   - weight, release_at,          OWNER + TEACHER: teachers author quizzes,
 *     closes_at, tokens_per_hour   so a quiz's schedule and weight are theirs
 *     on a QUIZ assignment:        too (TEACHER_ASSIGNMENT_FIELDS in
 *                                  @classmoji/utils quizAssignment.ts); on a
 *                                  REPO or FORM row tokens_per_hour is OWNER
 *                                  only, as every other general edit
 *   - closes_at:                   QUIZ rows only. Repos ignore a close date and
 *                                  a form closes through form_update, so it is
 *                                  refused there for every role.
 *   - grades_released on a QUIZ:   refused for every role: a quiz's score shows
 *                                  as soon as an attempt completes.
 *   - module_id (move):            OWNER only on every type (admin.$class.modules
 *                                  `moveAssignment` → requireClassroomAdmin →
 *                                  assignment.moveToModule, the drag between
 *                                  module cards)
 * The tool declares ['OWNER','TEACHER'] and enforces the OWNER-only fields
 * in-handler, per assignment type (ownerOnlyAssignmentFields), so the
 * assignment is loaded before the role check.
 *
 * Any assignment type can be updated (REPO, QUIZ, FORM), so the target is
 * resolved through its module (loadCourseworkAssignmentInClassroom), not its
 * repository. That matches the owner's web edit form (updateInClassroom) and
 * the calendar's deadline move, which both resolve through the module. The one
 * route that does not is the TEACHER's grades_released flip: it resolves
 * through the repository, so a quiz or form assignment is out of a teacher's
 * reach there, and grades_released on one is OWNER only here.
 *
 * Backbone: ClassmojiService.assignment.update — the NOTIFYING path, which on
 * a QUIZ row also writes the quiz's own copy of its due date, weight and status
 * in the same transaction (fires
 * ASSIGNMENT_DUE_DATE_CHANGED on deadline change and ASSIGNMENT_GRADED on a
 * false→true grades_released flip). Never assignment.releaseGrades, which is
 * the same DB write with the notification silently skipped (plan §5.2 gap 7).
 * updateInClassroom (the web path for the date fields) runs the same
 * notifyAfterUpdate, which ignores grader_deadline and release_at: neither
 * schedules anything on write. release_at is read later by the nightly
 * release cron (findReadyForRelease), the repo-provisioning filter, and the
 * student "locked" view; a null release_at is never auto-released.
 *
 * The move is NOT a column write. `Assignment.position` orders a module's
 * assignments, so module_id goes through assignment.moveToModuleEnd: one
 * transaction that puts the assignment at the end of the target and closes the
 * gap left in the source, with both modules locked so parallel moves into one
 * module do not collide (the drag's moveToModule needs the caller's full
 * ordering, which an agent does not hold). Nothing else about the assignment
 * changes (weight, deadlines, grades and submissions travel with it) and nobody
 * is notified.
 *
 * The move and the field edits are two writes, each audited as soon as it
 * lands, so a failure in the second never leaves the first unrecorded.
 */

import { ClassmojiService } from '@classmoji/services';
import { ownerOnlyAssignmentFields } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  holdsRole,
  loadAssignmentInClassroom,
  loadCourseworkAssignmentInClassroom,
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
  closes_at?: string | null;
  tokens_per_hour?: number;
  module_id?: string;
}

/**
 * Translate moveToModuleEnd's generic Errors. It re-checks both rows inside its
 * transaction, so a module or assignment deleted since the handler's own
 * checks gets the uniform not_found; an assignment another caller moved
 * somewhere else in the same instant is a retry.
 */
function translateMoveError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === 'Module not found in classroom') throw scopedNotFound('Module');
    if (error.message === 'Assignment not found in classroom') throw scopedNotFound('Assignment');
    if (error.message === 'Assignment moved concurrently') {
      throw new ToolError(
        'internal',
        'The assignment was moved by another request at the same time. Check list_modules and retry.'
      );
    }
  }
  throw error;
}

export const assignmentUpdateTool: ToolDefinition<AssignmentUpdateArgs> = {
  name: 'assignment_update',
  annotations: { destructive: false },
  title: 'Update an assignment',
  description:
    'Updates an assignment (a due-dated, gradeable unit of a module): student_deadline, ' +
    'weight, grades_released, grader_deadline, release_at, closes_at, tokens_per_hour and/or ' +
    'module_id. Owners can update all fields; teachers only grades_released and ' +
    'student_deadline, and on a quiz assignment student_deadline, weight, release_at, ' +
    'closes_at and tokens_per_hour. Releasing grades notifies graded students; moving the ' +
    'student deadline notifies affected students. release_at is when an unpublished repo ' +
    'assignment auto-releases (checked nightly); on a quiz it is when a published quiz opens. ' +
    'closes_at (quiz only) stops new attempts. A quiz shows its score at once, so ' +
    'grades_released is refused on one. Pass null to clear grader_deadline, release_at or ' +
    'closes_at.\n' +
    'module_id MOVES the assignment into another module of the classroom (see list_modules), ' +
    'at the end of that module’s assignments (module_reorder sets the order). This is how a lab, quiz or form assignment is ' +
    'placed in a week: an assignment belongs to exactly one module. Only the module changes: ' +
    'weight, deadlines, grades and submissions travel with it and nobody is notified. The ' +
    'student module list shows it under the new module, so a move into an unpublished module ' +
    'takes it off that list until the module is published.',
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
    // 0 is a real weight: a practice quiz or an ungraded check-in.
    weight: z.number().nonnegative().max(10000).optional().describe('Grading weight'),
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
      .describe(
        'Auto-release date (ISO 8601); null clears it. Owner only, or a teacher on a quiz assignment'
      ),
    closes_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('Quiz only: no new attempt from then on (ISO 8601); null reopens it'),
    tokens_per_hour: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Extension tokens per late hour (0 = no extensions)'),
    module_id: z
      .string()
      .uuid()
      .optional()
      .describe('Module to move the assignment into (see list_modules). Owner only'),
  },
  handler: async (args, ctx) => {
    const updates: Prisma.AssignmentUpdateInput = {};
    // The new value of each changed field for the audit row, as the web
    // calendar's deadline move records its new_deadline. Dates as ISO strings,
    // cleared dates as null.
    const values: Record<string, string | number | boolean | null> = {};
    const toDate = (iso: string | null) => (iso === null ? null : new Date(iso));
    const setDate = (
      field: 'student_deadline' | 'grader_deadline' | 'release_at' | 'closes_at',
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
    if (args.closes_at !== undefined) setDate('closes_at', args.closes_at);
    if (args.tokens_per_hour !== undefined) {
      updates.tokens_per_hour = values.tokens_per_hour = args.tokens_per_hour;
    }

    // What the caller asked to change, for the empty check and the role tier.
    // module_id is not a column write (see the header), so it is counted here
    // beside `updates` rather than inside it.
    const requested = [
      ...Object.keys(updates),
      ...(args.module_id !== undefined ? ['module_id'] : []),
    ];
    if (requested.length === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide at least one of: student_deadline, weight, grades_released, grader_deadline, ' +
          'release_at, closes_at, tokens_per_hour, module_id'
      );
    }

    // The per-field tier depends on the assignment's type, so the row is
    // loaded (S1) first; still nothing is written before the check.
    const classroom = requireClassroomCtx(ctx);
    const assignment = await loadCourseworkAssignmentInClassroom(args.assignment_id, ctx);

    // Fields that do not apply to this type, refused for every role before
    // the role check: a quiz's score shows as soon as an attempt completes, and
    // only a quiz has a close date (repos ignore one; a form closes through
    // form_update).
    if (assignment.type === 'QUIZ' && args.grades_released !== undefined) {
      throw new ToolError(
        'invalid_params',
        'A quiz shows its score as soon as an attempt completes: grades_released does not apply'
      );
    }
    if (assignment.type !== 'QUIZ' && args.closes_at !== undefined) {
      throw new ToolError(
        'invalid_params',
        assignment.type === 'REPO'
          ? 'closes_at is for quiz assignments: repos ignore a close date'
          : 'closes_at is for quiz assignments: a form closes with form_update closes_at'
      );
    }

    // Per-field tier: OWNER-only fields for this type need an OWNER membership
    // (checked via holdsRole so a multi-role OWNER whose gate resolved as
    // TEACHER passes). The web's teacher-tier grades_released route resolves
    // through the repository, so it never reaches a quiz or form assignment:
    // grades_released there is OWNER only too, and gets its own message.
    const ownerOnlyFields = ownerOnlyAssignmentFields(assignment.type, requested);
    const gradesReleasedOffRepo = args.grades_released !== undefined && assignment.type === 'FORM';
    if (
      (ownerOnlyFields.length > 0 || gradesReleasedOffRepo) &&
      !(await holdsRole(ctx, ['OWNER']))
    ) {
      throw new ToolError(
        'forbidden',
        gradesReleasedOffRepo
          ? 'Only the classroom owner can update grades_released on a form assignment'
          : `Only the classroom owner can update: ${ownerOnlyFields.join(', ')}`,
        'INSUFFICIENT_ROLE'
      );
    }

    // S1 for the move target, resolved before anything is written: the module
    // has to be in this classroom, and a foreign or unknown one gets the same
    // not_found. Naming the module the assignment is already in is not a move.
    let module = { id: assignment.module.id, title: assignment.module.title };
    let movedFromModuleId: string | null = null;
    if (args.module_id !== undefined && args.module_id !== assignment.module_id) {
      const target = await ClassmojiService.module.findById(args.module_id);
      if (!target || target.classroom_id !== classroom.classroomId) {
        throw scopedNotFound('Module');
      }
      let result;
      try {
        result = await ClassmojiService.assignment.moveToModuleEnd(
          assignment.id,
          target.id,
          classroom.classroomId
        );
      } catch (error) {
        translateMoveError(error);
      }
      module = { id: target.id, title: target.title };
      // `moved` is false when another call put it there first: this one wrote
      // nothing, so it records nothing.
      if (result.moved) {
        movedFromModuleId = result.fromModuleId;
        const moveValues = { module_id: target.id };
        await writeAudit(ctx, {
          resource_type: 'ASSIGNMENT',
          resource_id: assignment.id,
          action: 'UPDATE',
          data: {
            tool: 'assignment_update',
            fields: ['module_id'],
            values: moveValues,
            from_module_id: movedFromModuleId,
            value: JSON.stringify({ ...moveValues, from_module_id: movedFromModuleId }),
          },
        });
      }
    }

    const fields = Object.keys(updates);
    let updated: Pick<
      typeof assignment,
      | 'id'
      | 'title'
      | 'student_deadline'
      | 'weight'
      | 'grades_released'
      | 'grader_deadline'
      | 'release_at'
      | 'closes_at'
      | 'tokens_per_hour'
    > = assignment;
    if (fields.length > 0) {
      updated = await ClassmojiService.assignment.update(assignment.id, updates);
      await writeAudit(ctx, {
        resource_type: 'ASSIGNMENT',
        resource_id: assignment.id,
        action: 'UPDATE',
        // `value` is what keeps two different edits inside audit's 5s dedup window
        // from collapsing into one row; an identical re-send still dedups.
        data: { tool: 'assignment_update', fields, values, value: JSON.stringify(values) },
      });
    }

    return ok({
      success: true,
      assignment: {
        id: updated.id,
        title: updated.title,
        module_id: module.id,
        module_title: module.title,
        student_deadline: updated.student_deadline?.toISOString() ?? null,
        weight: updated.weight,
        grades_released: updated.grades_released,
        grader_deadline: updated.grader_deadline?.toISOString() ?? null,
        release_at: updated.release_at?.toISOString() ?? null,
        ...(assignment.type === 'QUIZ'
          ? { closes_at: updated.closes_at?.toISOString() ?? null }
          : {}),
        tokens_per_hour: updated.tokens_per_hour,
      },
      ...(movedFromModuleId ? { moved_from_module_id: movedFromModuleId } : {}),
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
    // 0 is a real weight: an ungraded check-in.
    weight: z.number().nonnegative().max(10000).optional().describe('Grading weight (default 100)'),
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
    'token balances. A quiz assignment is refused: it goes with its quiz (quiz_delete), or ' +
    'moves with quiz_update module_id.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    assignment_id: z.string().uuid().describe('Assignment id'),
  },
  handler: async (args, ctx) => {
    // A quiz's assignment is part of the quiz: refused by name, where the
    // classroom lists quizzes (elsewhere it is not found, like any row no read
    // surface shows).
    const record = await ClassmojiService.assignment.findById(args.assignment_id);
    if (
      record?.type === 'QUIZ' &&
      record.module?.classroom_id === requireClassroomCtx(ctx).classroomId
    ) {
      await loadCourseworkAssignmentInClassroom(args.assignment_id, ctx);
      throw new ToolError(
        'invalid_params',
        'A quiz’s assignment goes with the quiz: delete the quiz (quiz_delete), or move it to ' +
          'another module (quiz_update module_id).'
      );
    }
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
