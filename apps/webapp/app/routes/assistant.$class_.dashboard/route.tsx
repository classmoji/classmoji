import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';

import type { Route } from './+types/route';
import { PageHeader, StatsCard, StatsGradingProgress, TAGradingLeaderboard } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug!);

  return {
    data: Promise.all([
      ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(userId, classroom.id),
      ClassmojiService.repositoryAssignment.findByClassroomId(classroom.id),
      ClassmojiService.helper.findClassroomGradingProgressPerAssignment(classroom.id),
      ClassmojiService.repositoryAssignmentGrader.findGradersProgress(classroom.id),
    ]),
  };
};

const AssistantDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data } = loaderData;

  return (
    <div>
      <PageHeader title="Dashboard" routeName="dashboard" />

      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {(resolved: unknown) => {
            const [assignments, repoAssignments, gradingProgress, assistantsProgress] = resolved as [
              Array<{ repository_assignment?: { grades?: unknown[] }; [key: string]: unknown }>,
              unknown[],
              Array<{ id?: string; title: string; progress: number; student_deadline: string; [key: string]: unknown }>,
              Array<{ id: string; login: string; name: string | null; progress: number }>,
            ];
            const numUngradedAssignments = assignments.filter(
              (a) => a.repository_assignment?.grades?.length == 0
            )?.length;

            return (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <StatsCard title="Total Class Assignments">{repoAssignments?.length}</StatsCard>
                  <StatsCard title="My Assigned">{assignments?.length}</StatsCard>
                  <StatsCard title="My Ungraded">{numUngradedAssignments}</StatsCard>
                </div>
                <div className="grid grid-cols-5 gap-4 mt-8">
                  <div className="col-span-4">
                    <StatsGradingProgress gradingProgress={gradingProgress} />
                  </div>
                  <div className="col-span-1">
                    <TAGradingLeaderboard progress={assistantsProgress} />
                  </div>
                </div>
              </>
            );
          }}
        </Await>
      </Suspense>
    </div>
  );
};

export const action = () => {
  return { message: 'Success' };
};

export default AssistantDashboard;
