import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { loadGradingScreenData } from '~/utils/gradingScreen.server';
import { GradingScreen } from '~/components/features/grading';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'DASHBOARD',
    action: 'view_dashboard',
  });

  if (!classroom) {
    throw new Response('Classroom not found', { status: 404 });
  }

  const grading = await loadGradingScreenData(classroom.id, classSlug!);

  return { grading };
};

const AdminDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { grading } = loaderData;

  // TODO: Phase 4d - wire `onOpenSubmission` to the admin assignment detail route
  // once it exists. Today there is no canonical admin single-submission route.
  return (
    <GradingScreen
      stats={grading.stats}
      queue={grading.queue}
      analytics={grading.analytics}
      students={grading.students}
    />
  );
};

export default AdminDashboard;
