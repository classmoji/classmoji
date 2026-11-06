/**
 * submission_late_override — set or clear the late-penalty exemption
 * (GitRepoAssignment.is_late_override) on one submission, a list of them, or
 * every submission of an assignment; or, for a quiz, staff's late waiver for
 * one student (`QuizLateWaiver`, #813, D3: one tool for every kind of
 * submission).
 *
 * Mirrors apps/webapp/app/routes/api.gitRepoAssignment.$class (updateLateOverride,
 * the shield button): allowedRoles ['OWNER','TEACHER'] + the classroom mutation
 * gate. Both are registry-enforced here — `roles: OWNER_TEACHER` and step 4 of
 * the pipeline (assertMutationAllowed → the same canMutateClassroom predicate
 * the webapp's assertClassroomMutationAllowed uses), so non-owners are refused
 * on a LOCKED or UNPUBLISHED classroom and an owner is not, exactly as on web.
 *
 * WHICH ROWS ARE WRITTEN — the rows the web would offer its waive button on
 * (SubmissionsTable / LateOverrideButton show it only when `is_late ||
 * is_late_override`), enforced in the service (setLateOverrideInClassroom):
 *   - Setting (true) writes only submissions past their deadline; on-time ones
 *     are skipped as `not_late`, in every mode, including a single named id.
 *     An exempt on-time row would count as late in the late-percentage and
 *     dashboard figures and read "Late waived".
 *   - Setting by assignment_id also skips submissions with nothing turned in
 *     (`not_submitted`): the exemption switches off their missing-work zero, and
 *     waiving the late penalty for a class must not waive missing work. An
 *     unsubmitted-but-past-deadline row NAMED by id is still written — the web
 *     offers waive on that row too.
 *   - Clearing (false) writes any row that carries the exemption.
 *
 * ONE tool, not a single + `_bulk` pair: grader_assign_bulk is separate because
 * its semantics differ (RANDOM/EXISTING distribution, a background run); here
 * the write is identical and only the selector differs, as in team_members_add.
 *
 * S1: every id is resolved inside the authorized classroom. The service puts
 * `git_repo.classroom_id` in the WHERE of both its read and its write, so a
 * foreign id is never matched or written and lands in not_found alongside ids
 * that do not exist. assignment_id is classroom-verified up front
 * (loadAssignmentInClassroom): the scoped query would otherwise answer a
 * foreign assignment with "0 matched" instead of not_found. The loader
 * scopes through `repository`, so an assignment without one (quiz/form
 * coursework) is not_found too — it has no repo submissions to exempt.
 *
 * Audit (the web action writes none): ONE row per submission actually changed,
 * resource GIT_REPO_ASSIGNMENT/<id>, with the value under `data.value`. A
 * single row per call would need a resource_id, and list mode has none — so two
 * different lists set to the same value within the audit service's 5-second
 * dedup window would collapse and the second call would go unrecorded.
 * Per-submission rows have distinct resource ids, so they cannot collide with
 * each other and can be written in parallel chunks. The rows are written AFTER
 * the committed update, so an audit failure cannot undo it: the call still
 * reports what it changed, flags `audit_incomplete` with the ids whose row
 * failed, and logs the error server-side (never to the client).
 *
 * QUIZ MODE (`quiz_id`, or a QUIZ `assignment_id`, with `student_id`):
 * mirrors apps/webapp/app/routes/api.quizLateWaiver.$class (the quiz shield):
 * the same roles and mutation rule (registry), the same service
 * (`quizLateWaiver.setQuizLateWaiver`, which resolves the assignment as a
 * QUIZ of this classroom and the student as an accepted STUDENT of it, so a
 * foreign or unknown id is not_found), and the same audit row: resource
 * QUIZ_LATE_WAIVER/<assignment id>, `data.kind: 'quiz'`, the student, the
 * quiz and the value, never deduped, written only when the call changed
 * something. The waiver is per (quiz, student), so:
 *   - `student_id` is required; an assignment_id of a QUIZ without one is
 *     refused, never read as "the whole class" (a class-wide waiver is not a
 *     thing staff want);
 *   - like a repo submission's, it is set only where something is late: the
 *     service refuses `not_late` (invalid_params here) for a student with no
 *     completed attempt late past the due date plus their hours. Never ahead
 *     of time. Clearing is always allowed;
 *   - it takes away late penalties only: a student with no completed attempt
 *     still counts 0 after the deadline.
 * Repo-only fields (`git_repo_assignment_id(s)`) never go with student_id.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  loadAssignmentInClassroom,
  loadCourseworkAssignmentInClassroom,
  loadQuizInClassroom,
  ok,
  OWNER_TEACHER,
  requireClassroomCtx,
  scopedNotFound,
  submissionIdSchema,
  writeAudit,
} from './shared.ts';

/** Largest id list one call accepts (list_submissions' own page cap). */
export const LATE_OVERRIDE_MAX_IDS = 500;
/** Each id list in the response is cut to this many; the counts stay exact. */
export const LATE_OVERRIDE_ID_LIST_CAP = 100;
/** Audit rows written concurrently per chunk. */
export const LATE_OVERRIDE_AUDIT_CHUNK = 20;

interface LateOverrideArgs {
  classroom: string;
  git_repo_assignment_id?: string;
  git_repo_assignment_ids?: string[];
  assignment_id?: string;
  quiz_id?: string;
  student_id?: string;
  is_late_override: boolean;
}

type Mode = 'single' | 'ids' | 'assignment';

/** The audit `resource_type` of a quiz waiver row, shared with the web shield. */
export const QUIZ_LATE_WAIVER_RESOURCE = 'QUIZ_LATE_WAIVER';

/**
 * Whether `assignmentId` is a QUIZ assignment of this classroom that its
 * members can see (the coursework loader's rule). Read only after the repo
 * loader refused it, to tell "this is a quiz, name a student" apart from
 * not_found without revealing anything about other classrooms.
 */
async function isQuizAssignmentHere(assignmentId: string, ctx: ToolContext): Promise<boolean> {
  try {
    const { classroomId } = requireClassroomCtx(ctx);
    // Hidden quizzes leave no trace: the quiz tools' own predicate.
    if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) return false;
    const record = await loadCourseworkAssignmentInClassroom(assignmentId, ctx);
    return record.type === 'QUIZ';
  } catch {
    return false;
  }
}

/**
 * Quiz mode: set or clear one student's late waiver on one QUIZ assignment of
 * this classroom (see the header). The assignment comes from `quiz_id` or
 * `assignment_id`, each resolved inside the authorized classroom first.
 */
async function quizLateOverride(args: LateOverrideArgs & { student_id: string }, ctx: ToolContext) {
  const { classroomId } = requireClassroomCtx(ctx);

  // Either selector, as list_quiz_attempts and quiz_attempt_adjust: a classroom
  // whose quizzes are hidden (not Pro, switched off, or no quiz runtime) has none
  // to name, and says so the same way before anything is looked up.
  if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
    throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
  }

  let assignmentId: string;
  if (args.quiz_id !== undefined) {
    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    if (!quiz.assignment?.id) {
      throw new ToolError(
        'invalid_params',
        'This quiz is in no module, so it has no due date and no late penalty to waive'
      );
    }
    assignmentId = quiz.assignment.id;
  } else {
    const assignment = await loadCourseworkAssignmentInClassroom(args.assignment_id!, ctx);
    if (assignment.type !== 'QUIZ') {
      throw new ToolError(
        'invalid_params',
        'student_id goes with a quiz assignment only; this assignment is not a quiz'
      );
    }
    assignmentId = assignment.id;
  }

  let result: { changed: boolean; waived: boolean; quizId: string };
  try {
    result = await ClassmojiService.quizLateWaiver.setQuizLateWaiver({
      classroomId,
      assignmentId,
      studentId: args.student_id,
      waived: args.is_late_override,
      actorId: ctx.viewer.userId,
    });
  } catch (error) {
    // QuizLateWaiverError, by name (the class lives in @classmoji/services).
    const code =
      (error as { name?: string; code?: string } | null)?.name === 'QuizLateWaiverError'
        ? (error as { code?: string }).code
        : undefined;
    if (code === 'not_quiz') {
      throw new ToolError('invalid_params', 'Only a quiz assignment takes a quiz late waiver');
    }
    if (code === 'not_late') {
      throw new ToolError('invalid_params', 'This student has no late attempt on this quiz');
    }
    if (code === 'self') {
      throw new ToolError('forbidden', 'You cannot waive your own late penalty');
    }
    if (code === 'not_student') throw scopedNotFound('Student');
    if (code === 'not_found') throw scopedNotFound('Assignment');
    throw error;
  }

  // One row per change, after the committed write (as the repo rows are).
  let auditFailed = false;
  if (result.changed) {
    try {
      await writeAudit(ctx, {
        resource_type: QUIZ_LATE_WAIVER_RESOURCE,
        resource_id: assignmentId,
        action: 'UPDATE',
        data: {
          tool: 'submission_late_override',
          kind: 'quiz',
          field: 'quiz_late_waiver',
          value: args.is_late_override,
          assignment_id: assignmentId,
          quiz_id: result.quizId,
          student_id: args.student_id,
        },
        dedupe: false,
      });
    } catch (error) {
      auditFailed = true;
      console.error('[mcp] submission_late_override: quiz audit write failed:', error);
    }
  }

  return ok({
    success: true,
    is_late_override: args.is_late_override,
    mode: 'quiz',
    assignment_id: assignmentId,
    quiz_id: result.quizId,
    student_id: args.student_id,
    updated_count: result.changed ? 1 : 0,
    unchanged_count: result.changed ? 0 : 1,
    ...(auditFailed ? { audit_incomplete: true } : {}),
  });
}

/**
 * Write one audit row per changed submission, LATE_OVERRIDE_AUDIT_CHUNK at a
 * time in parallel (distinct resource ids, so no row dedups another). Returns
 * the ids whose row could not be written; the errors are logged here and never
 * reach the client.
 */
async function auditChangedRows(
  ctx: ToolContext,
  ids: string[],
  data: { value: boolean; mode: Mode; assignment_id?: string }
): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += LATE_OVERRIDE_AUDIT_CHUNK) {
    const chunk = ids.slice(i, i + LATE_OVERRIDE_AUDIT_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(id =>
        writeAudit(ctx, {
          resource_type: 'GIT_REPO_ASSIGNMENT',
          resource_id: id,
          action: 'UPDATE',
          data: { tool: 'submission_late_override', field: 'is_late_override', ...data },
        })
      )
    );
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failed.push(chunk[index]);
        console.error(
          `[mcp] submission_late_override: audit write failed for ${chunk[index]}:`,
          outcome.reason
        );
      }
    });
  }
  return failed;
}

export const submissionLateOverrideTool: ToolDefinition<LateOverrideArgs> = {
  name: 'submission_late_override',
  // Flips one boolean on our own rows and can be flipped back → not
  // destructive; repeating the call changes nothing further → idempotent.
  annotations: { destructive: false, idempotent: true },
  title: 'Set or clear the late-penalty exemption',
  description:
    'Sets (is_late_override=true) or clears (false) the late-penalty exemption, like the web ' +
    'shield. Owner or teacher. Give exactly one selector. Repo: git_repo_assignment_id (one ' +
    'submission, the `id` from list_submissions), git_repo_assignment_ids (up to 500), or ' +
    'assignment_id (every submission of that repo assignment). Setting skips on-time ' +
    'submissions (not_late), and assignment_id mode also skips ones never turned in ' +
    '(not_submitted), so missing work keeps its zero; clearing works on any exempt one. Ids ' +
    'missing or outside this classroom come back in not_found, untouched; ones already at the ' +
    'value are unchanged. late_count: matched submissions past the deadline ignoring any ' +
    'exemption; late_updated_count: the same over the changed ones. Id lists are capped at 100 ' +
    '(ids_truncated); counts are exact. Quiz: quiz_id, or a quiz assignment_id, plus student_id ' +
    '(required: a quiz waiver is per student, never class-wide). Setting needs a completed ' +
    'attempt late past the due date plus bought hours, else invalid_params; never ahead of ' +
    "time. It covers all that student's attempts: none counts late (late_override in " +
    'list_quiz_attempts). Not taking the quiz is not waived: no completed attempt still counts ' +
    '0. Response: mode quiz, updated_count 1 or 0.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema()
      .optional()
      .describe('One submission (GitRepoAssignment) id'),
    git_repo_assignment_ids: z
      .array(submissionIdSchema())
      .min(1)
      .max(LATE_OVERRIDE_MAX_IDS)
      .optional()
      .describe(`Several submission ids (1–${LATE_OVERRIDE_MAX_IDS})`),
    assignment_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        'A repo Assignment (every submission of it), or a quiz Assignment (with student_id)'
      ),
    quiz_id: z.string().uuid().optional().describe('A quiz (see list_quizzes); needs student_id'),
    student_id: z
      .string()
      .uuid()
      .optional()
      .describe('Quiz mode: the student whose late penalty to waive or restore'),
    is_late_override: z.boolean().describe('true = exempt from late penalties, false = clear'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Cheapest check first: exactly one selector, before any lookup.
    const given = [
      args.git_repo_assignment_id !== undefined,
      args.git_repo_assignment_ids !== undefined,
      args.assignment_id !== undefined,
      args.quiz_id !== undefined,
    ].filter(Boolean).length;
    if (given !== 1) {
      throw new ToolError(
        'invalid_params',
        'Give exactly one of git_repo_assignment_id, git_repo_assignment_ids, assignment_id, ' +
          'or quiz_id'
      );
    }
    if (
      args.student_id !== undefined &&
      (args.git_repo_assignment_id !== undefined || args.git_repo_assignment_ids !== undefined)
    ) {
      throw new ToolError(
        'invalid_params',
        'student_id goes with quiz_id or a quiz assignment_id, not with submission ids'
      );
    }
    if (args.quiz_id !== undefined && args.student_id === undefined) {
      throw new ToolError(
        'invalid_params',
        'quiz_id needs student_id: a quiz late waiver is set per student'
      );
    }

    // Quiz mode: a quiz, or an assignment named together with a student.
    if (args.student_id !== undefined) {
      return quizLateOverride({ ...args, student_id: args.student_id }, ctx);
    }

    let mode: Mode;
    let selector: { ids: string[] } | { assignmentId: string };
    if (args.assignment_id !== undefined) {
      mode = 'assignment';
      let assignment: Awaited<ReturnType<typeof loadAssignmentInClassroom>>;
      try {
        assignment = await loadAssignmentInClassroom(args.assignment_id, ctx);
      } catch (error) {
        // A quiz assignment has no repository, so the repo loader cannot find
        // it. Say what it needs instead of not_found: never the whole class.
        if (await isQuizAssignmentHere(args.assignment_id, ctx)) {
          throw new ToolError(
            'invalid_params',
            'A quiz assignment needs student_id: a quiz late waiver is set per student, ' +
              'never for a whole class'
          );
        }
        throw error;
      }
      selector = { assignmentId: assignment.id };
    } else if (args.git_repo_assignment_id !== undefined) {
      mode = 'single';
      selector = { ids: [args.git_repo_assignment_id] };
    } else {
      mode = 'ids';
      selector = { ids: args.git_repo_assignment_ids ?? [] };
    }

    const result = await ClassmojiService.gitRepoAssignment.setLateOverrideInClassroom({
      classroomId: classroom.classroomId,
      selector,
      isLateOverride: args.is_late_override,
    });

    // One submission asked for and not in this classroom: the same uniform
    // not_found grade_add gives, so a probe learns nothing either way.
    if (mode === 'single' && result.notFoundIds.length > 0) {
      throw scopedNotFound('Submission');
    }

    const assignmentId = 'assignmentId' in selector ? selector.assignmentId : undefined;
    const auditFailedIds = await auditChangedRows(ctx, result.updatedIds, {
      value: args.is_late_override,
      mode,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    });

    const late = new Set(result.lateIds);
    const cap = (ids: string[]) => ids.slice(0, LATE_OVERRIDE_ID_LIST_CAP);
    const idsTruncated = [
      result.updatedIds,
      result.unchangedIds,
      result.notFoundIds,
      result.notLateIds,
      result.notSubmittedIds,
      auditFailedIds,
    ].some(ids => ids.length > LATE_OVERRIDE_ID_LIST_CAP);

    return ok({
      success: true,
      is_late_override: args.is_late_override,
      mode,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      // A single named submission that was not written because it is on time.
      ...(mode === 'single' && result.notLateIds.length > 0
        ? {
            reason:
              'not_late: the submission is not past its deadline, so there is no penalty to waive',
          }
        : {}),
      matched_count:
        result.updatedIds.length +
        result.unchangedIds.length +
        result.notLateIds.length +
        result.notSubmittedIds.length,
      updated_count: result.updatedIds.length,
      unchanged_count: result.unchangedIds.length,
      not_late_count: result.notLateIds.length,
      not_submitted_count: result.notSubmittedIds.length,
      not_found_count: result.notFoundIds.length,
      late_count: result.lateIds.length,
      late_updated_count: result.updatedIds.filter(id => late.has(id)).length,
      updated_ids: cap(result.updatedIds),
      unchanged_ids: cap(result.unchangedIds),
      not_late_ids: cap(result.notLateIds),
      not_submitted_ids: cap(result.notSubmittedIds),
      not_found_ids: cap(result.notFoundIds),
      ids_truncated: idsTruncated,
      ...(auditFailedIds.length > 0
        ? { audit_incomplete: true, audit_failed_ids: cap(auditFailedIds) }
        : {}),
    });
  },
};
