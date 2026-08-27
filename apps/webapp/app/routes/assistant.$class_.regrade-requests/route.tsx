import type { Route } from './+types/route';
import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  // Named so a denial is identifiable rather than the shared default
  // 'TEACHING_RESOURCE'/'access'. 'REGRADE_REQUEST' is the vocabulary the MCP
  // regrade tools already write, so denials and mutations line up. Served under
  // /assistant and /teacher alike.
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'REGRADE_REQUEST',
    action: 'view_regrade_requests',
  });
  const requests = await ClassmojiService.regradeRequest.findMany({
    classroom_id: classroom.id,
  });
  const emojiMappings = (await ClassmojiService.emojiMapping.findByClassroomId(
    classroom.id
  )) as Record<string, number>;
  return { requests, emojiMappings, org: classroom.git_organization?.login };
};

const AssistantRegradeRequests = ({ loaderData }: Route.ComponentProps) => {
  const { requests, emojiMappings, org } = loaderData;

  return (
    <>
      <RegradeRequestsTable requests={requests} emojiMappings={emojiMappings} org={org} />
    </>
  );
};

export default AssistantRegradeRequests;
