/**
 * extension_purchase — a student spends tokens to buy extension hours on their
 * own repository submission or on a quiz assignment they take.
 *
 * Mirrors the student Assignments page's purchase action, student path only:
 * STUDENT tier, always self — the paying student is ALWAYS the caller.
 *
 * Exactly one target, checked in the handler (the input is a flat shape, so
 * the schema cannot say "one of"):
 *   - git_repo_assignment_id: the caller's own individual submission (derived
 *     from the DB, never the request) → token.purchaseExtensionHours.
 *   - assignment_id: a QUIZ assignment open to students in this classroom →
 *     token.purchaseQuizExtensionHours. The hours move the caller's own due
 *     date on that quiz. A draft, not-yet-open, hidden or foreign assignment
 *     is the uniform not_found, from the loader here and from the service's
 *     own checks alike, so a probe cannot tell them apart from an id that
 *     does not exist. A REPO assignment id is refused with a pointer to
 *     git_repo_assignment_id (the hours belong to a submission there).
 *
 * All pricing and gating lives in packages/services (the price derives from
 * Assignment.tokens_per_hour, else the classroom's default; the late-override
 * refusal, deadline and price checks are re-enforced server-side; balance
 * check inside the DB transaction). Hours can be bought at any time, before
 * or after the deadline, submitted or not.
 * (The dormant api.extension.$class createExtension endpoint is a separate
 * OWNER/TEACHER grant flow and is intentionally not mirrored.)
 */

import { ClassmojiService } from '@classmoji/services';
import { openToStudents } from '@classmoji/utils';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import {
  loadCourseworkAssignmentInClassroom,
  loadGitRepoAssignmentInClassroom,
  ok,
  requireClassroomCtx,
  scopedNotFound,
  submissionIdSchema,
  writeAudit,
} from './shared.ts';

/**
 * The service's domain rejections are intentional user-facing messages
 * (mirrored verbatim from the web action). Surface those as invalid_params;
 * anything else stays a generic internal error (no leaked internals).
 */
export const DOMAIN_ERROR_PREFIXES = [
  'Invalid hours',
  'Repository assignment not found',
  // Also the quiz path's "no deadline" and "only students buy extension hours".
  'Extensions are unavailable',
  'Token cost not configured',
  'Insufficient token balance',
];

/**
 * The quiz path's "no such quiz here" refusal (token.purchaseQuizExtensionHours:
 * not a QUIZ of this classroom, or not open to students). It covers rows the
 * caller may not see (a draft, a quiz not yet open, one in another classroom),
 * so it becomes the same uniform not_found an unknown id gets.
 */
export const QUIZ_NOT_FOUND_PREFIXES = ['Quiz assignment not found'];

function toDomainError(error: unknown): ToolError | null {
  if (error instanceof Error && DOMAIN_ERROR_PREFIXES.some(p => error.message.startsWith(p))) {
    return new ToolError('invalid_params', error.message);
  }
  return null;
}

function toQuizError(error: unknown): ToolError | null {
  if (error instanceof Error && QUIZ_NOT_FOUND_PREFIXES.some(p => error.message.startsWith(p))) {
    return scopedNotFound('Assignment');
  }
  return toDomainError(error);
}

interface ExtensionPurchaseArgs {
  classroom: string;
  git_repo_assignment_id?: string;
  assignment_id?: string;
  hours: number;
}

interface PurchaseRow {
  id: string;
  hours_purchased: number | null;
  amount: number;
  balance_after: number;
}

const transactionOf = (transaction: PurchaseRow) => ({
  id: transaction.id,
  hours_purchased: transaction.hours_purchased,
  amount: transaction.amount,
  balance_after: transaction.balance_after,
});

/** Hours on the caller's own submission (a REPO assignment). */
async function purchaseOnSubmission(
  args: ExtensionPurchaseArgs & { git_repo_assignment_id: string },
  ctx: ToolContext
) {
  // S1 + self-scoping: the submission must exist in the authorized classroom
  // AND belong to the calling student's own individual repo (team repos have
  // no single owner to charge). Same non-leaking error either way.
  const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);
  if (gra.git_repo.student_id !== ctx.viewer.userId) {
    throw scopedNotFound('Submission');
  }

  try {
    // Pricing + late-override gate + balance check all inside the service.
    const transaction = await ClassmojiService.token.purchaseExtensionHours({
      classroomId: gra.git_repo.classroom_id,
      studentId: ctx.viewer.userId,
      gitRepoAssignmentId: gra.id,
      hours: args.hours,
    });

    await writeAudit(ctx, {
      resource_type: 'TOKEN_PURCHASE',
      resource_id: transaction.id,
      action: 'CREATE',
      data: {
        tool: 'extension_purchase',
        git_repo_assignment_id: gra.id,
        hours: args.hours,
        amount: transaction.amount,
      },
    });

    return ok({
      success: true,
      git_repo_assignment_id: gra.id,
      transaction: transactionOf(transaction),
    });
  } catch (error) {
    const domainError = toDomainError(error);
    if (domainError) throw domainError;
    throw error;
  }
}

/** Hours on a quiz: they move the caller's own due date on it. */
async function purchaseOnQuiz(
  args: ExtensionPurchaseArgs & { assignment_id: string },
  ctx: ToolContext
) {
  // S1: an assignment of this classroom (via its module), and a QUIZ one only
  // where the classroom shows quizzes; anything else is the uniform not_found.
  const assignment = await loadCourseworkAssignmentInClassroom(args.assignment_id, ctx);
  // What a student may see at all (published, open, its repository or form
  // published). Checked BEFORE the type refusals below, so they never confirm
  // a row the caller cannot see. The loader already applied the quiz gate.
  if (!openToStudents(assignment, new Date(), { quizzesVisible: true })) {
    throw scopedNotFound('Assignment');
  }
  if (assignment.type === 'REPO') {
    throw new ToolError(
      'invalid_params',
      'This is a repository assignment: buy its hours on your submission with ' +
        'git_repo_assignment_id (my_submission.id in list_repos), not assignment_id.'
    );
  }
  if (assignment.type !== 'QUIZ') {
    throw new ToolError(
      'invalid_params',
      'Extensions are unavailable for this assignment: only repository and quiz assignments ' +
        'take extension hours.'
    );
  }

  try {
    // Classroom, type, open-to-students, STUDENT payer, deadline, price and
    // balance are all re-checked inside the service.
    const transaction = await ClassmojiService.token.purchaseQuizExtensionHours({
      classroomId: requireClassroomCtx(ctx).classroomId,
      studentId: ctx.viewer.userId,
      assignmentId: assignment.id,
      hours: args.hours,
    });

    await writeAudit(ctx, {
      resource_type: 'TOKEN_PURCHASE',
      resource_id: transaction.id,
      action: 'CREATE',
      data: {
        tool: 'extension_purchase',
        assignment_id: assignment.id,
        hours: args.hours,
        amount: transaction.amount,
      },
    });

    return ok({
      success: true,
      assignment_id: assignment.id,
      transaction: transactionOf(transaction),
    });
  } catch (error) {
    const quizError = toQuizError(error);
    if (quizError) throw quizError;
    throw error;
  }
}

export const extensionPurchaseTool: ToolDefinition<ExtensionPurchaseArgs> = {
  name: 'extension_purchase',
  // Spends the caller's own tokens; a purchase can be cancelled (refunded)
  // from the web tokens page, so it is not marked destructive.
  annotations: { destructive: false },
  title: 'Purchase extension hours',
  description:
    'Spends YOUR tokens to buy extension hours on one of YOUR OWN assignments (students ' +
    'only). Give exactly one of: git_repo_assignment_id for a repository assignment (your ' +
    'submission, my_submission.id in list_repos) or assignment_id for a quiz (assignment_id ' +
    'in list_quizzes). Works at any time: before the deadline the hours push your deadline ' +
    'out, after it they reduce how late the submission or quiz attempt counts. The price per ' +
    'hour is the assignment’s tokens_per_hour, or the classroom’s default when that is null ' +
    '(effective_tokens_per_hour in list_repos and list_quizzes; 0 = no extensions). Nothing ' +
    'but your balance limits how many you buy, so buy no more hours than you need. An ' +
    'assignment with no deadline has nothing to extend. Check your balance with my_tokens first.',
  scope: 'write',
  roles: ['STUDENT'],
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema()
      .optional()
      .describe('Your submission (GitRepoAssignment) id, for a repository assignment'),
    assignment_id: z
      .string()
      .uuid()
      .optional()
      .describe('A quiz assignment id (assignment_id in list_quizzes)'),
    hours: z.number().int().positive().max(1000).describe('Extension hours to purchase'),
  },
  handler: async (args, ctx) => {
    // Cheapest check first: exactly one target, before any lookup.
    const given = [args.git_repo_assignment_id, args.assignment_id].filter(
      id => id !== undefined
    ).length;
    if (given !== 1) {
      throw new ToolError(
        'invalid_params',
        'Give exactly one of git_repo_assignment_id (a repository submission) or assignment_id (a quiz)'
      );
    }

    if (args.assignment_id !== undefined) {
      return purchaseOnQuiz({ ...args, assignment_id: args.assignment_id }, ctx);
    }
    return purchaseOnSubmission(
      { ...args, git_repo_assignment_id: args.git_repo_assignment_id as string },
      ctx
    );
  },
};
