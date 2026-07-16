/**
 * extension_purchase — a student spends tokens to buy late hours on their own
 * submission (plan §5.2 gap 6, extract-first — Phase 3).
 *
 * Mirrors apps/webapp/app/routes/student.$class.assignments
 * purchaseExtensionHours: assertClassroomAccess allows OWNER/TEACHER plus
 * STUDENT self-access (resourceOwnerId = the paying student). MCP exposes the
 * live student path only — STUDENT tier, always self: the paying student is
 * ALWAYS the caller, and the submission must be the caller's own individual
 * repo (derived from the DB, never the request).
 *
 * All pricing and gating lives in packages/services
 * token.purchaseExtensionHours (S9 — price derives from
 * Assignment.tokens_per_hour; deadline, late-override, and purchasable-hour
 * caps re-enforced server-side; balance check inside the DB transaction).
 * (The dormant api.extension.$class createExtension endpoint is a separate
 * OWNER/TEACHER grant flow and is intentionally not mirrored.)
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { loadGitRepoAssignmentInClassroom, ok, scopedNotFound, writeAudit } from './shared.ts';

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
  'The deadline for this assignment has not passed yet',
  'No purchasable late hours remain',
  'You can purchase at most',
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
  title: 'Purchase late-hour extension',
  description:
    'Spends YOUR tokens to buy late hours on one of YOUR OWN overdue assignments (students ' +
    'only). The price per hour comes from the assignment (tokens_per_hour); the deadline must ' +
    'have passed, and you can buy at most the remaining late hours. Check your balance and ' +
    'assignment cost first via the assignments/tokens resources.',
  scope: 'write',
  roles: ['STUDENT'],
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    git_repo_assignment_id: z.string().uuid().describe('Your submission (GitRepoAssignment) id'),
    hours: z.number().int().positive().max(1000).describe('Late hours to purchase'),
  },
  handler: async (args, ctx) => {
    // S1 + self-scoping: the submission must exist in the authorized classroom
    // AND belong to the calling student's own individual repo (team repos have
    // no single owner to charge). Same non-leaking error either way.
    const gra = await loadGitRepoAssignmentInClassroom(args.git_repo_assignment_id, ctx);
    if (gra.git_repo.student_id !== ctx.viewer.userId) {
      throw scopedNotFound('Submission');
    }

    try {
      // Pricing + deadline gates + cap + balance check all inside the service.
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
