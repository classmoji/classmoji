import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { loadStaffRegradeRows } from '~/utils/regradeRequestRows.server';
import { canMutate } from '~/utils/mutationRefusal.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom, userId, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REGRADE_REQUESTS',
    action: 'view_requests',
  });

  const emojiMappings = await ClassmojiService.emojiMapping.findScaleByClassroomId(classroom.id);
  const latePenaltyPerHour = Number(classroom.settings?.late_penalty_points_per_hour ?? 0) || 0;
  const requests = await loadStaffRegradeRows({
    classroomId: classroom.id,
    scale: emojiMappings,
    viewer: { userId, role: membership?.role, tool: 'web:regrade_requests.view' },
  });
  return {
    requests,
    emojiMappings,
    latePenaltyPerHour,
    org: classroom.git_organization?.login,
    // Resolve and grade controls show only where the classroom takes changes.
    canResolve: canMutate(classroom, membership?.role),
  };
};

// The quiz resolve action carries its own teaching-team gate (an OWNER
// passes it); the /admin layout loader is no mutation boundary.
export { action } from '../assistant.$class_.regrade-requests/route';

const AdminRegradeRequests = ({ loaderData }: Route.ComponentProps) => {
  const { requests, emojiMappings, latePenaltyPerHour, org, canResolve } = loaderData;

  return (
    <RegradeRequestsTable
      requests={requests}
      emojiMappings={emojiMappings}
      latePenaltyPerHour={latePenaltyPerHour}
      org={org}
      canResolve={canResolve}
    />
  );
};

export default AdminRegradeRequests;
