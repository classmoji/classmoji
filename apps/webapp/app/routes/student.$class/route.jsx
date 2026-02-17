import { Outlet, useLoaderData } from 'react-router';
import { useEffect } from 'react';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';
import useStore from '~/store';

export const loader = async ({ params, request }) => {
  const { userId, classroom } = await requireStudentAccess(
    request,
    params.class,
    { resourceType: 'TOKEN_BALANCE', action: 'view_balance' }
  );

  // Fetch token balance for the student
  const tokenBalance = await ClassmojiService.token.getBalance(
    classroom.id,
    userId
  );

  return {
    tokenBalance,
    classroomId: classroom.id,
    userId,
  };
};

const StudentOrg = () => {
  const loaderData = useLoaderData();
  const { setTokenBalance } = useStore(state => state);

  // Sync token balance to Zustand store when it changes
  useEffect(() => {
    if (loaderData?.tokenBalance !== null && loaderData?.tokenBalance !== undefined) {
      setTokenBalance(loaderData.tokenBalance);
    }
  }, [loaderData?.tokenBalance, setTokenBalance]);

  return <Outlet />;
};

export default StudentOrg;
