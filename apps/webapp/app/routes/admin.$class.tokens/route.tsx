import { useNavigate, Outlet } from 'react-router';
import dayjs from 'dayjs';

import { PageHeader, ButtonNew, TriggerProgress, ProTierFeature } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { TokensScreen, type TokenTransaction } from '~/components/features/tokens';
import type { Route } from './+types/route';

interface RawTokenTx {
  id: string;
  type: string;
  amount: number;
  description?: string | null;
  created_at: string | Date;
  student?: { name?: string | null } | null;
  repository_assignment?: {
    assignment?: { title?: string | null } | null;
  } | null;
}

const GAIN_TYPES = new Set(['GAIN', 'REFUND']);

function toScreenTransaction(tx: RawTokenTx): TokenTransaction {
  const isGain = GAIN_TYPES.has(tx.type);
  const assignmentTitle = tx.repository_assignment?.assignment?.title ?? null;
  const studentName = tx.student?.name ?? null;
  const baseNote =
    tx.description || assignmentTitle || (isGain ? 'Tokens granted' : 'Tokens spent');
  const note = studentName ? `${studentName} — ${baseNote}` : baseNote;
  return {
    id: tx.id,
    type: isGain ? 'GAIN' : 'SPENDING',
    note,
    when: dayjs(tx.created_at).format('MMM D, YYYY'),
    amount: isGain ? Math.abs(tx.amount) : -Math.abs(tx.amount),
  };
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TOKEN_HISTORY',
    action: 'view_transactions',
  });

  const rawTransactions = await ClassmojiService.token.findTransactions({
    classroom_id: classroom.id,
    is_cancelled: false,
  });

  const transactions = (rawTransactions as unknown as RawTokenTx[]).map(toScreenTransaction);
  const earned = transactions
    .filter(t => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);
  const spent = transactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const balance = earned - spent;

  return { transactions, balance, earned, spent };
};

const AdminTokensLog = ({ loaderData }: Route.ComponentProps) => {
  const { transactions, balance, earned, spent } = loaderData;
  const navigate = useNavigate();

  return (
    <ProTierFeature>
      <Outlet />
      <TriggerProgress
        operation="ASSIGN_TOKENS_TO_STUDENT"
        validIdentifiers={['assign_tokens_to_student']}
      />
      <PageHeader title="Tokens" routeName="tokens">
        <ButtonNew action={() => navigate('../tokens/new', { relative: 'path' })}>
          Assign Tokens
        </ButtonNew>
      </PageHeader>

      <TokensScreen
        balance={balance}
        earned={earned}
        spent={spent}
        transactions={transactions}
      />
    </ProTierFeature>
  );
};

export default AdminTokensLog;
