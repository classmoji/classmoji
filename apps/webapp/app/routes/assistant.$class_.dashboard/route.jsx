import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';

import { PageHeader, StatsCard, StatsGradingProgress, TAGradingLeaderboard } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug);

  const promises = {
    assignments: ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(userId, classroom.id),
    repoAssignments: ClassmojiService.repositoryAssignment.findByClassroomId(classroom.id),
    gradingProgress: ClassmojiService.helper.findClassroomGradingProgressPerAssignment(classroom.id),
    assistantsProgress: ClassmojiService.repositoryAssignmentGrader.findGradersProgress(classroom.id),
  };

  return {
    data: Promise.all(Object.values(promises)),
  };
};

const AssistantDashboard = ({ loaderData }) => {
  const { data } = loaderData;

  return (
    <div>
      <PageHeader title="Dashboard" routeName="dashboard" />

      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {([assignments, repoAssignments, gradingProgress, assistantsProgress]) => {
            const numUngradedAssignments = assignments.filter(a => a.repository_assignment?.grades?.length == 0)?.length;

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
