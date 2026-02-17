import { PageHeader, TokensLog } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class, {
    resourceType: 'TOKEN_TRANSACTIONS',
    action: 'view_transactions',
  });

  const transactions = await ClassmojiService.token.findTransactions({
    classroom_id: classroom.id,
    student_id: userId,
  });
  return { transactions };
};

const StudentTokensLog = ({ loaderData }) => {
  const { transactions } = loaderData;
  return (
    <>
      <PageHeader title="Tokens" routeName="tokens" />
      <TokensLog transactions={transactions} />
    </>
  );
};

export default StudentTokensLog;
