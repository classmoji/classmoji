import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { loadGradingScreenData } from '~/utils/gradingScreen.server';
import { GradingScreen } from '~/components/features/grading';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!);

  const grading = await loadGradingScreenData(classroom.id, classSlug!);

  return { grading };
};

const AssistantGrading = ({ loaderData }: Route.ComponentProps) => {
  const { grading } = loaderData;

  // TODO: Phase 4d - wire `onOpenSubmission` to the admin/assistant assignment
  // detail route once it exists.
  return <GradingScreen stats={grading.stats} queue={grading.queue} />;
};

export const action = () => {
  return { message: 'Success' };
};

export default AssistantGrading;
