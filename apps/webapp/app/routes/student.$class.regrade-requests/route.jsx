import { Outlet } from 'react-router';

import { ClassmojiService } from '@classmoji/services';
import { RegradeRequestsTable } from '~/components/';
import { requireStudentAccess } from '~/utils/helpers';

export const loader = async ({ request, params }) => {
  const { userId, classroom } = await requireStudentAccess(
    request,
    params.class,
    { resourceType: 'REGRADE_REQUESTS', action: 'view_regrade_requests' }
  );

  const regradeRequests = await ClassmojiService.regradeRequest.findMany({
    student_id: userId,
    classroom_id: classroom.id,
  });
  return { regradeRequests, org: classroom.git_organization?.login };
};

const StudentRegradeRequests = ({ loaderData }) => {
  const { regradeRequests, org } = loaderData;
  return (
    <>
      <Outlet />
      <RegradeRequestsTable requests={regradeRequests} org={org} />
    </>
  );
};

export default StudentRegradeRequests;
