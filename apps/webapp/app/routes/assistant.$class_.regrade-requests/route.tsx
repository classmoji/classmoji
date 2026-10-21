import type { Route } from './+types/route';
import { RegradeRequestsTable } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { loadStaffRegradeRows } from '~/utils/regradeRequestRows.server';
import { resolveQuizRegradeAction } from './resolveQuizRegrade.server';

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
  // The classroom's scale, once: the repo picker's options and every quiz
  // emoji on the page.
  const emojiMappings = await ClassmojiService.emojiMapping.findScaleByClassroomId(classroom.id);
  const latePenaltyPerHour = Number(classroom.settings?.late_penalty_points_per_hour ?? 0) || 0;
  const requests = await loadStaffRegradeRows({
    classroomId: classroom.id,
    scale: emojiMappings,
    latePenaltyPerHour,
  });
  return { requests, emojiMappings, latePenaltyPerHour, org: classroom.git_organization?.login };
};

/**
 * Resolve a quiz request (Adjust score / Keep score). The teaching team,
 * assistants included (D5); the gate and the classroom scoping live in
 * `resolveQuizRegradeAction`. Re-exported by the /admin and /teacher routes.
 */
export const action = async ({ request, params }: Route.ActionArgs) =>
  resolveQuizRegradeAction(request, params.class!);

const AssistantRegradeRequests = ({ loaderData }: Route.ComponentProps) => {
  const { requests, emojiMappings, latePenaltyPerHour, org } = loaderData;

  return (
    <RegradeRequestsTable
      requests={requests}
      emojiMappings={emojiMappings}
      latePenaltyPerHour={latePenaltyPerHour}
      org={org}
    />
  );
};

export default AssistantRegradeRequests;
