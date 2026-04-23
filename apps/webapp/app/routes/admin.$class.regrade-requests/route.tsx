// TODO: Phase 5 final restyle
import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

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

const AdminRegradeRequests = ({ loaderData }: Route.ComponentProps) => {
  const { requests, emojiMappings, org } = loaderData;

  return (
    <RegradeRequestsTable
      requests={
        requests as unknown as React.ComponentProps<typeof RegradeRequestsTable>['requests']
      }
      emojiMappings={emojiMappings as Record<string, unknown>}
      org={org}
    />
  );
};

export default AdminRegradeRequests;
