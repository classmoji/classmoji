// TODO: Phase 5 final restyle
import { Outlet } from 'react-router';

import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { RegradeRequestsTable } from '~/components/';
import { requireStudentAccess } from '~/utils/helpers';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'REGRADE_REQUESTS',
    action: 'view_regrade_requests',
  });

  const regradeRequests = await ClassmojiService.regradeRequest.findMany({
    student_id: userId,
    classroom_id: classroom.id,
  });
  return { regradeRequests, org: classroom.git_organization?.login };
};

const StudentRegradeRequests = ({ loaderData }: Route.ComponentProps) => {
  const { regradeRequests, org } = loaderData;
  return (
    <>
      <Outlet />
      <RegradeRequestsTable requests={regradeRequests} org={org} />
    </>
  );
};

export default StudentRegradeRequests;
