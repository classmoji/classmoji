/**
 * `tokens` — classmoji://{org}/{slug}/tokens (STUDENT self).
 *
 * Mirrors student.$class.tokens (requireStudentAccess): the caller's own
 * token ledger in this classroom, scoped by (classroom_id, student_id) —
 * self-access needs no resourceOwnerId re-derivation because the query is
 * keyed to the viewer's own user id, never a request-supplied one.
 * Compact rows: the web loader embeds the full student User row and raw
 * relations; here the ledger keeps scalar fields + assignment context only.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ResourceDefinition } from '../mcp/registry.ts';
import { STUDENT_ONLY, classroomCtx } from './shape.ts';

interface TransactionRow {
  id: string;
  amount: number;
  type: string;
  hours_purchased?: number | null;
  balance_after: number;
  description: string;
  is_cancelled: boolean;
  created_at: Date;
  git_repo_assignment?: {
    id: string;
    assignment?: { id: string; title?: string | null } | null;
  } | null;
  assignment_grade?: { id: string; emoji?: string } | null;
}

export const tokensResource: ResourceDefinition = {
  name: 'tokens',
  uriTemplate: 'classmoji://{org}/{slug}/tokens',
  title: 'My token ledger',
  description:
    'Your token balance and transaction history in this classroom (grants, purchases, refunds, ' +
    'removals). Students only.',
  scope: 'read',
  roles: STUDENT_ONLY,
  handler: async (_vars, ctx) => {
    const { classroomId } = classroomCtx(ctx);
    const [balance, transactions] = await Promise.all([
      ClassmojiService.token.getBalance(classroomId, ctx.viewer.userId),
      ClassmojiService.token.findTransactions({
        classroom_id: classroomId,
        student_id: ctx.viewer.userId,
      }) as Promise<TransactionRow[]>,
    ]);

    return {
      balance,
      transactions: transactions.map(t => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        hours_purchased: t.hours_purchased ?? null,
        balance_after: t.balance_after,
        description: t.description,
        is_cancelled: t.is_cancelled,
        created_at: t.created_at,
        assignment_title: t.git_repo_assignment?.assignment?.title ?? null,
        grade_emoji: t.assignment_grade?.emoji ?? null,
      })),
    };
  },
};
