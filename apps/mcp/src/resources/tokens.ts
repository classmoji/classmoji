/**
 * `tokens` — classmoji://{org}/{slug}/tokens (STUDENT self).
 *
 * Mirrors student.$class.tokens (requireStudentAccess): the caller's own
 * token ledger in this classroom, scoped by (classroom_id, student_id) —
 * self-access needs no resourceOwnerId re-derivation because the query is
 * keyed to the viewer's own user id, never a request-supplied one.
 * Compact rows: the web loader embeds the full student User row and raw
 * relations; here the ledger keeps scalar fields + assignment context only.
 *
 * Each row names the assignment it is about: a quiz extension through its own
 * `assignment` link, a repository extension or grade token through its
 * submission's assignment. `assignment_id` is that assignment's id (the one
 * extension_purchase takes for a quiz). A quiz extension whose assignment was
 * deleted keeps no link, so its title is read back from the row's
 * description, the "<title> · +N h" snapshot written with it.
 */

import { ClassmojiService } from '@classmoji/services';
import { transactionAssignmentTitle } from '@classmoji/utils';
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
  /** A quiz extension's assignment (set null if the assignment is deleted). */
  assignment_id?: string | null;
  git_repo_assignment_id?: string | null;
  assignment?: { id: string; title?: string | null } | null;
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
    'removals). Each row names the assignment it is about (assignment_id, assignment_title), ' +
    'quiz extensions included. Students only.',
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
        assignment_id: t.assignment_id ?? t.git_repo_assignment?.assignment?.id ?? null,
        // The live title; for a quiz extension whose assignment is gone, the
        // title its description was written with. Grants and removals name
        // none: their description is free text.
        assignment_title: transactionAssignmentTitle(t),
        grade_emoji: t.assignment_grade?.emoji ?? null,
      })),
    };
  },
};
