import dayjs from 'dayjs';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';
import { TokensScreen, type TokenTransaction } from '~/components/features/tokens';

interface RawTokenTx {
  id: string;
  type: string;
  amount: number;
  description?: string | null;
  created_at: string | Date;
  repository_assignment?: {
    assignment?: { title?: string | null } | null;
  } | null;
}

const GAIN_TYPES = new Set(['GAIN', 'REFUND']);

function toScreenTransaction(tx: RawTokenTx): TokenTransaction {
  const isGain = GAIN_TYPES.has(tx.type);
  const note =
    tx.description ||
    tx.repository_assignment?.assignment?.title ||
    (isGain ? 'Tokens granted' : 'Tokens spent');
  return {
    id: tx.id,
    type: isGain ? 'GAIN' : 'SPENDING',
    note,
    when: dayjs(tx.created_at).format('MMM D, YYYY'),
    amount: isGain ? Math.abs(tx.amount) : -Math.abs(tx.amount),
  };
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'TOKEN_TRANSACTIONS',
    action: 'view_transactions',
  });

  const [rawTransactions, balance] = await Promise.all([
    ClassmojiService.token.findTransactions({
      classroom_id: classroom.id,
      student_id: userId,
      is_cancelled: false,
    }),
    ClassmojiService.token.getBalance(classroom.id, userId),
  ]);

  const transactions = (rawTransactions as unknown as RawTokenTx[]).map(toScreenTransaction);
  const earned = transactions
    .filter(t => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);
  const spent = transactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return { transactions, balance, earned, spent };
};

const StudentTokensLog = ({ loaderData }: Route.ComponentProps) => {
  const { transactions, balance, earned, spent } = loaderData;
  return (
    <TokensScreen
      balance={balance}
      earned={earned}
      spent={spent}
      transactions={transactions}
      onSpend={() => {
        // Spend-on-extension entrypoint is handled inside the extension itself.
        // Keep this as a no-op CTA for now so the button renders for students.
      }}
    />
  );
};

export default StudentTokensLog;
