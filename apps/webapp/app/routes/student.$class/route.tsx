import { Outlet } from 'react-router';
import { useEffect } from 'react';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';
import { staffRedirectFromStudentRoute } from '~/utils/studentRouteRedirect.server';
import useStore from '~/store';

/**
 * Gates the whole /student/:class subtree to STUDENT members.
 *
 * Staff who land here (a shared or bookmarked student URL) are redirected to
 * the same screen in their own section, or its dashboard (#403) — see
 * utils/studentRouteRedirect.ts. The refusal is still made and audit-logged
 * first; only what the staff member sees changes. Everyone else gets the
 * refusal as before.
 *
 * Like every layout loader, this is not a mutation boundary: a POST to a
 * student leaf runs that leaf's action before this loader, so each action
 * keeps its own gate.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  let access;
  try {
    access = await requireStudentAccess(request, params.class!, {
      resourceType: 'TOKEN_BALANCE',
      action: 'view_balance',
    });
  } catch (error: unknown) {
    const staffRedirect = await staffRedirectFromStudentRoute(request, params.class!, error);
    if (staffRedirect) throw staffRedirect;
    throw error;
  }
  const { userId, classroom } = access;

  // Fetch token balance for the student
  const tokenBalance = await ClassmojiService.token.getBalance(classroom.id, userId);

  return {
    tokenBalance,
    classroomId: classroom.id,
    userId,
  };
};

const StudentOrg = ({ loaderData }: Route.ComponentProps) => {
  const { setTokenBalance } = useStore();

  // Sync token balance to Zustand store when it changes
  useEffect(() => {
    if (loaderData?.tokenBalance !== null && loaderData?.tokenBalance !== undefined) {
      setTokenBalance(loaderData.tokenBalance);
    }
  }, [loaderData?.tokenBalance, setTokenBalance]);

  return <Outlet />;
};

export default StudentOrg;
