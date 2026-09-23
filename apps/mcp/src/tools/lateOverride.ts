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
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
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
/** Audit rows written concurrently per chunk. */
export const LATE_OVERRIDE_AUDIT_CHUNK = 20;

interface LateOverrideArgs {
  classroom: string;
  git_repo_assignment_id?: string;
  git_repo_assignment_ids?: string[];
  assignment_id?: string;
  is_late_override: boolean;
}

type Mode = 'single' | 'ids' | 'assignment';

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
    'Sets (is_late_override=true) or clears (false) the late-penalty exemption on submissions, ' +
    'like the shield button in the web grading view. Owner or teacher. Give exactly one of: ' +
    'git_repo_assignment_id (one submission — the `id` from list_submissions, as grade_add ' +
    'takes it), git_repo_assignment_ids (up to 500), or assignment_id (every submission of that ' +
    'repo assignment in this classroom). Setting skips submissions that are not late ' +
    '(not_late), and assignment_id mode also skips ones never turned in (not_submitted), so ' +
    'missing work keeps its zero; clearing works on any exempt submission. Ids missing or ' +
    'outside this classroom come back in not_found and are never touched; submissions already ' +
    'at the value are unchanged. late_count is how many matched submissions are past the ' +
    'deadline ignoring any exemption; late_updated_count is the same over the ones this call ' +
    'changed. Id lists in the response are capped at 100 (ids_truncated); counts are exact.',
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
      .describe('Every submission of this (repo) Assignment in this classroom'),
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
