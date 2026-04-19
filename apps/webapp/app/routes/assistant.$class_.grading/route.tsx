import { useEffect } from 'react';
import { useFetcher, useRevalidator } from 'react-router';
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
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();

  const refreshing = fetcher.state !== 'idle';
  const refreshingId =
    refreshing && fetcher.formAction
      ? fetcher.formAction.match(/\/api\/repos\/([^/]+)\/refresh/)?.[1] ?? null
      : null;

  const handleRefresh = (repositoryAssignmentId: string) => {
    fetcher.submit(null, {
      method: 'POST',
      action: `/api/repos/${repositoryAssignmentId}/refresh`,
    });
  };

  // When the fetcher returns success, revalidate so the loader picks up
  // the fresh snapshot (the Trigger.dev workflow writes to the DB).
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && (fetcher.data as { enqueued?: boolean }).enqueued) {
      revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidate]);

  return (
    <GradingScreen
      stats={grading.stats}
      queue={grading.queue}
      analytics={grading.analytics}
      students={grading.students}
      onRefreshSubmission={handleRefresh}
      refreshingSubmissionId={refreshingId}
    />
  );
};

export const action = () => {
  return { message: 'Success' };
};

export default AssistantGrading;
