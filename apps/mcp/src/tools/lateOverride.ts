/**
 * submission_late_override — set or clear the late-penalty exemption
 * (GitRepoAssignment.is_late_override) on one submission, a list of them, or
 * every submission of an assignment.
 *
 * Mirrors apps/webapp/app/routes/api.gitRepoAssignment.$class (updateLateOverride,
 * the shield button): allowedRoles ['OWNER','TEACHER'] + the classroom mutation
 * gate. Both are registry-enforced here — `roles: OWNER_TEACHER` and step 4 of
 * the pipeline (assertMutationAllowed → the same canMutateClassroom predicate
 * the webapp's assertClassroomMutationAllowed uses), so non-owners are refused
 * on a LOCKED or UNPUBLISHED classroom and an owner is not, exactly as on web.
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
 * foreign assignment with "0 matched" instead of not_found.
 *
 * Audit (the web action writes none): ONE row per submission actually changed,
 * resource GIT_REPO_ASSIGNMENT/<id>, with the value under `data.value`. A
 * single row per call would need a resource_id, and list mode has none — so two
 * different lists set to the same value within the audit service's 5-second
 * dedup window would collapse and the second call would go unrecorded.
 * Per-submission rows have distinct resource ids and cannot collide, and
 * `value` joins the dedup key so on/off flips of one submission both record.
 * Rows already at the value are not written and not audited.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadAssignmentInClassroom,
  ok,
  OWNER_TEACHER,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

/** Largest id list one call accepts (list_submissions' own page cap). */
export const LATE_OVERRIDE_MAX_IDS = 500;
/** Each id list in the response is cut to this many; the counts stay exact. */
export const LATE_OVERRIDE_ID_LIST_CAP = 100;

interface LateOverrideArgs {
  classroom: string;
  git_repo_assignment_id?: string;
  git_repo_assignment_ids?: string[];
  assignment_id?: string;
  is_late_override: boolean;
}

type Mode = 'single' | 'ids' | 'assignment';

export const submissionLateOverrideTool: ToolDefinition<LateOverrideArgs> = {
  name: 'submission_late_override',
  // Flips one boolean on our own rows and can be flipped back → not
  // destructive; repeating the call changes nothing further → idempotent.
  annotations: { destructive: false, idempotent: true },
  title: 'Set or clear the late-penalty exemption',
  description:
    'Sets (is_late_override=true) or clears (false) the late-penalty exemption on submissions, ' +
    'like the shield button in the web grading view. Owner or teacher. Give exactly one of: ' +
    'git_repo_assignment_id (one submission — the `id` from list_submissions, as grade_add ' +
    'takes it), git_repo_assignment_ids (up to 500), or assignment_id (every submission of that ' +
    'assignment in this classroom). Ids missing or outside this classroom come back in ' +
    'not_found and are never touched; submissions already at the value are unchanged. ' +
    'late_count is how many matched submissions are past the deadline ignoring any exemption ' +
    '(an unsubmitted one counts once the deadline passes); late_updated_count is the same over ' +
    'the ones this call changed. assignment_id covers every submission that exists now, ' +
    "including students who haven't turned it in yet, but not repos created after the call — " +
    're-run it for those. Id lists in the response are capped at 100 (ids_truncated); counts ' +
    'are exact.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z
      .string()
      .uuid()
      .optional()
      .describe('One submission (GitRepoAssignment) id'),
    git_repo_assignment_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(LATE_OVERRIDE_MAX_IDS)
      .optional()
      .describe(`Several submission ids (1–${LATE_OVERRIDE_MAX_IDS})`),
    assignment_id: z
      .string()
      .uuid()
      .optional()
      .describe('Every submission of this Assignment in this classroom'),
    is_late_override: z.boolean().describe('true = exempt from late penalties, false = clear'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Cheapest check first: exactly one selector, before any lookup.
    const given = [
      args.git_repo_assignment_id !== undefined,
      args.git_repo_assignment_ids !== undefined,
      args.assignment_id !== undefined,
    ].filter(Boolean).length;
    if (given !== 1) {
      throw new ToolError(
        'invalid_params',
        'Give exactly one of git_repo_assignment_id, git_repo_assignment_ids, or assignment_id'
      );
    }

    let mode: Mode;
    let selector: { ids: string[] } | { assignmentId: string };
    if (args.assignment_id !== undefined) {
      mode = 'assignment';
      const assignment = await loadAssignmentInClassroom(args.assignment_id, ctx);
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

    for (const id of result.updatedIds) {
      await writeAudit(ctx, {
        resource_type: 'GIT_REPO_ASSIGNMENT',
        resource_id: id,
        action: 'UPDATE',
        data: {
          tool: 'submission_late_override',
          field: 'is_late_override',
          value: args.is_late_override,
          mode,
          ...(mode === 'assignment' && 'assignmentId' in selector
            ? { assignment_id: selector.assignmentId }
            : {}),
        },
      });
    }

    const late = new Set(result.lateIds);
    const cap = (ids: string[]) => ids.slice(0, LATE_OVERRIDE_ID_LIST_CAP);
    const idsTruncated = [result.updatedIds, result.unchangedIds, result.notFoundIds].some(
      ids => ids.length > LATE_OVERRIDE_ID_LIST_CAP
    );

    return ok({
      success: true,
      is_late_override: args.is_late_override,
      mode,
      ...('assignmentId' in selector ? { assignment_id: selector.assignmentId } : {}),
      matched_count: result.updatedIds.length + result.unchangedIds.length,
      updated_count: result.updatedIds.length,
      unchanged_count: result.unchangedIds.length,
      not_found_count: result.notFoundIds.length,
      late_count: result.lateIds.length,
      late_updated_count: result.updatedIds.filter(id => late.has(id)).length,
      updated_ids: cap(result.updatedIds),
      unchanged_ids: cap(result.unchangedIds),
      not_found_ids: cap(result.notFoundIds),
      ids_truncated: idsTruncated,
    });
  },
};
