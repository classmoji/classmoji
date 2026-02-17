import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug);
  const requests = await ClassmojiService.regradeRequest.findMany({
    classroom_id: classroom.id,
  });
  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);
  return { requests, emojiMappings, org: classroom.git_organization?.login };
};

const AssistantRegradeRequests = ({ loaderData }) => {
  const { requests, emojiMappings, org } = loaderData;

  return (
    <>
      <RegradeRequestsTable requests={requests} emojiMappings={emojiMappings} org={org} />
    </>
  );
};

export default AssistantRegradeRequests;
