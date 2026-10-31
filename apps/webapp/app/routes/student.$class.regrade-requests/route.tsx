import { Outlet } from 'react-router';

import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { RegradeRequestsTable } from '~/components/';
import { requireStudentAccess } from '~/utils/helpers';
import { loadStudentRegradeRows } from '~/utils/regradeRequestRows.server';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'REGRADE_REQUESTS',
    action: 'view_regrade_requests',
  });

  // The student's own requests only (session user + the gate's classroom).
  // Quiz attempts reach the page as the classroom's emoji, never a number.
  const scale = await ClassmojiService.emojiMapping.findScaleByClassroomId(classroom.id);
  const regradeRequests = await loadStudentRegradeRows({
    classroomId: classroom.id,
    studentId: userId,
    scale,
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
