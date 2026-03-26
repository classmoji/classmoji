import { useNavigate, Outlet } from 'react-router';

import { PageHeader, TokensLog, ButtonNew, TriggerProgress, ProTierFeature } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TOKEN_HISTORY',
    action: 'view_transactions',
  });

  const transactions = await ClassmojiService.token.findTransactions({
    classroom_id: classroom.id,
  });
  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  return { transactions, students };
};

const AdminTokensLog = ({ loaderData }: Route.ComponentProps) => {
  const { transactions, students } = loaderData;
  const navigate = useNavigate();

  // Calculate token statistics
  const totalTransactions = transactions.length;

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

      <div className="space-y-6">
        {/* Tokens Log */}
        <TokensLog
          transactions={transactions}
          rowKey={(record: Record<string, unknown>) => record.id as string}
          students={students}
        />
      </div>
    </ProTierFeature>
  );
};

export default AdminTokensLog;
