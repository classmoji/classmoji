import { useNavigate, Outlet } from 'react-router';

import { TokensLog, ButtonNew, TriggerProgress, ProTierFeature } from '~/components';
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
  const _totalTransactions = transactions.length;

  return (
    <ProTierFeature>
      <div className="min-h-full relative">
        <Outlet />
        <TriggerProgress
          operation="ASSIGN_TOKENS_TO_STUDENT"
          validIdentifiers={['assign_tokens_to_student']}
        />

        <div className="flex items-center justify-between gap-3 mt-2 mb-4">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Tokens</h1>

          <ButtonNew action={() => navigate('../tokens/new', { relative: 'path' })}>
            Assign tokens
          </ButtonNew>
        </div>

        <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
          <TokensLog
            transactions={transactions}
            rowKey={(record: Record<string, unknown>) => record.id as string}
            students={students}
          />
        </div>
      </div>
    </ProTierFeature>
  );
};

export default AdminTokensLog;
