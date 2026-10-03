/**
 * extension_purchase — a student spends tokens to buy late hours on their own
 * submission (plan §5.2 gap 6, extract-first — Phase 3).
 *
 * Mirrors apps/webapp/app/routes/student.$class.assignments
 * purchaseExtensionHours: assertClassroomAccess allows OWNER/TEACHER plus
 * STUDENT self-access (resourceOwnerId = the paying student). MCP exposes the
 * live student path only — STUDENT tier, always self: the paying student is
 * ALWAYS the caller, and the submission must be the caller's own repo or a
 * repo of a team they are on (derived from the DB, never the request), as the
 * web lets any team member buy hours for their team from their own balance.
 *
 * All pricing and gating lives in packages/services
 * token.purchaseExtensionHours (S9 — price derives from
 * Assignment.tokens_per_hour; the late-override refusal is re-enforced
 * server-side; balance check inside the DB transaction). Hours can be bought
 * at any time, before or after the deadline, submitted or not.
 * (The dormant api.extension.$class createExtension endpoint is a separate
 * OWNER/TEACHER grant flow and is intentionally not mirrored.)
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadGitRepoAssignmentInClassroom,
  ok,
  scopedNotFound,
  submissionIdSchema,
  writeAudit,
} from './shared.ts';

/**
 * The service's domain rejections are intentional user-facing messages
 * (mirrored verbatim from the web action). Surface those as invalid_params;
 * anything else stays a generic internal error (no leaked internals).
 */
const DOMAIN_ERROR_PREFIXES = [
  'Invalid hours',
  'Repository assignment not found',
  'Extensions are unavailable',
  'Token cost not configured',
  'Insufficient token balance',
];

function toDomainError(error: unknown): ToolError | null {
  if (error instanceof Error && DOMAIN_ERROR_PREFIXES.some(p => error.message.startsWith(p))) {
    return new ToolError('invalid_params', error.message);
  }
  return null;
}

interface ExtensionPurchaseArgs {
  classroom: string;
  git_repo_assignment_id: string;
  hours: number;
}

export const extensionPurchaseTool: ToolDefinition<ExtensionPurchaseArgs> = {
  name: 'extension_purchase',
  annotations: { destructive: false },
  title: 'Purchase extension hours',
  description:
    'Spends YOUR tokens to buy extension hours on one of YOUR OWN assignments, or your ' +
    'team’s (students only). Works at any time: before the deadline the hours push your deadline out, after ' +
    'it they reduce how late the submission counts. The price per hour is the assignment’s ' +
    'tokens_per_hour, or the classroom’s default when that is null; nothing but your balance ' +
    'limits how many you buy, so ' +
    'buy no more hours than you need. An assignment with no deadline has nothing to extend. ' +
    'Your extension counts net of refunds: a cancelled purchase takes its hours back. Check ' +
    'your balance and assignment cost first via the assignments/tokens resources.',
  scope: 'write',
  roles: ['STUDENT'],
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: submissionIdSchema().describe('Your submission (GitRepoAssignment) id'),
    hours: z.number().int().positive().max(1000).describe('Extension hours to purchase'),
  },
  handler: async (args, ctx) => {
    // S1 + self-scoping: the submission must exist in the authorized classroom
    // AND be the calling student's own repo or their team's (the caller pays
    // from their own balance). Same non-leaking error either way.
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);
    const ownRepo = gra.git_repo.student_id === ctx.viewer.userId;
    const teamRepo =
      !ownRepo && gra.git_repo.team_id
        ? await ClassmojiService.teamMembership.isTeamMember(
            gra.git_repo.team_id,
            ctx.viewer.userId
          )
        : false;
    if (!ownRepo && !teamRepo) {
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
        transaction: {
          id: transaction.id,
          hours_purchased: transaction.hours_purchased,
          amount: transaction.amount,
          balance_after: transaction.balance_after,
        },
      });
    } catch (error) {
      const domainError = toDomainError(error);
      if (domainError) throw domainError;
      throw error;
    }
  },
};
