/**
 * token_grant — grant tokens to a student.
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.tokens.new:
 * requireClassroomAdmin — OWNER only. The web action fans out per-student to
 * the `assign_tokens_to_student` Trigger.dev task, whose entire body is
 * ClassmojiService.token.assignToStudent — MCP calls that same service
 * directly (identical effect, no queue dependency).
 *
 * S9: amount is z.number().int().positive(); the target must hold a STUDENT
 * membership in THIS classroom (verified against the DB before granting).
 * token.assignToStudent computes balance_after from the student's latest
 * transaction inside a DB transaction.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

interface TokenGrantArgs {
  classroom: string;
  student_id: string;
  amount: number;
  description?: string;
}

export const tokenGrantTool: ToolDefinition<TokenGrantArgs> = {
  name: 'token_grant',
  annotations: { destructive: false },
  title: 'Grant tokens to a student',
  description:
    'Grants extension/reward tokens to one student in the classroom. Owner only. The student ' +
    'must be an enrolled STUDENT member.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    student_id: z.string().uuid().describe('User id of the student'),
    amount: z.number().int().positive().max(10000).describe('Tokens to grant (positive integer)'),
    description: z.string().max(500).optional().describe('Reason shown in the ledger'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // The target must be a STUDENT member of THIS classroom (S9) — same
    // non-leaking rejection whether the user is unknown or merely elsewhere.
    const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.classroomId,
      args.student_id,
      ['STUDENT']
    );
    if (!membership) {
      throw scopedNotFound('Student');
    }

    const transaction = await ClassmojiService.token.assignToStudent({
      classroomId: classroom.classroomId,
      studentId: args.student_id,
      amount: args.amount,
      type: 'GAIN',
      ...(args.description ? { description: args.description } : {}),
    });

    await writeAudit(ctx, {
      resource_type: 'TOKEN_GRANT',
      resource_id: transaction.id,
      action: 'CREATE',
      data: { tool: 'token_grant', student_id: args.student_id, amount: args.amount },
    });

    return ok({
      success: true,
      transaction: {
        id: transaction.id,
        student_id: transaction.student_id,
        amount: transaction.amount,
        balance_after: transaction.balance_after,
      },
    });
  },
};
