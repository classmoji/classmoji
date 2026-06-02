import type { Route } from './+types/route';
import { TokensLog } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'TOKEN_TRANSACTIONS',
    action: 'view_transactions',
  });

  const transactions = await ClassmojiService.token.findTransactions({
    classroom_id: classroom.id,
    student_id: userId,
  });
  return { transactions };
};

const StudentTokensLog = ({ loaderData }: Route.ComponentProps) => {
  const { transactions } = loaderData;
  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-ink-2">Tokens</h1>
      </div>

      <div
        data-tour="tokens-log"
        className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]"
      >
        <TokensLog transactions={transactions} />
      </div>
    </div>
  );
};

export default StudentTokensLog;
