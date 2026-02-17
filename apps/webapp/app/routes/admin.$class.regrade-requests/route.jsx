import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REGRADE_REQUESTS',
    action: 'view_requests',
  });

  const requests = await ClassmojiService.regradeRequest.findMany({
    classroom_id: classroom.id,
  });
  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);
  return { requests, emojiMappings, org: classroom.git_organization?.login };
};

const AdminRegradeRequests = ({ loaderData }) => {
  const { requests, emojiMappings, org } = loaderData;

  return <RegradeRequestsTable requests={requests} emojiMappings={emojiMappings} org={org} />;
};

export default AdminRegradeRequests;
