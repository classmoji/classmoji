import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';

import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import GradingTabsCard from '../admin.$class.dashboard/GradingTabsCard';
import {
  MyDayQueue,
  ThroughputSparkline,
  StreakBadge,
  OwnVsClassHistogram,
} from '~/components/features/dashboard';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug!);

  const cockpitPromise = Promise.all([
    ClassmojiService.taDashboard.overdueQueue(userId, classroom.id),
    ClassmojiService.taDashboard.personalThroughput(userId, classroom.id),
    ClassmojiService.taDashboard.gradingStreak(userId, classroom.id),
    ClassmojiService.taDashboard.personalGradeDistribution(userId, classroom.id),
  ]).catch(() => null);

  return {
    data: Promise.all([
      ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(userId, classroom.id),
      ClassmojiService.repositoryAssignment.findByClassroomId(classroom.id),
      ClassmojiService.helper.findClassroomGradingProgressPerAssignment(classroom.id),
      ClassmojiService.repositoryAssignmentGrader.findGradersProgress(classroom.id),
    ]),
    cockpit: cockpitPromise,
  };
};

interface StatItemProps {
  label: string;
  value: string | number;
  subtitle?: string;
  valueColor?: string;
}

const StatItem = ({ label, value, subtitle, valueColor }: StatItemProps) => (
  <div className="flex-1 min-w-0 flex items-start justify-between gap-3 px-4 sm:px-5 py-4">
    <div className="min-w-0">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div
        className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight leading-tight"
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 truncate">
          {subtitle}
        </div>
      )}
    </div>
  </div>
);

const AssistantDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data, cockpit } = loaderData;

  return (
    <div className="min-h-full flex flex-col gap-4">
      <h1 className="mt-2 mb-1 text-base font-semibold text-gray-600 dark:text-gray-400">
        Dashboard
      </h1>

      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {(resolved: unknown) => {
            const [assignments, repoAssignments, gradingProgress, assistantsProgress] =
              resolved as [
                Array<{ repository_assignment?: { grades?: unknown[] }; [key: string]: unknown }>,
                unknown[],
                Array<{
                  id?: string;
                  title: string;
                  progress: number;
                  student_deadline: string;
                  [key: string]: unknown;
                }>,
                Array<{ id: string; login: string; name: string | null; progress: number }>,
              ];
            const numUngradedAssignments = assignments.filter(
              a => a.repository_assignment?.grades?.length === 0
            ).length;
            const totalClass = repoAssignments?.length ?? 0;
            const myAssigned = assignments?.length ?? 0;
            const myGraded = myAssigned - numUngradedAssignments;

            const ungradedSubtitle =
              myAssigned > 0
                ? `${myGraded} of ${myAssigned} graded`
                : 'nothing assigned yet';

            return (
              <>
                <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 overflow-hidden flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-stone-200/70 dark:divide-gray-800">
                  <StatItem
                    label="Class assignments"
                    value={totalClass}
                    subtitle={totalClass === 1 ? 'repository' : 'repositories'}
                  />
                  <StatItem
                    label="My assigned"
                    value={myAssigned}
                    valueColor="#619462"
                    subtitle={myAssigned === 1 ? 'repository' : 'repositories'}
                  />
                  <StatItem
                    label="My ungraded"
                    value={numUngradedAssignments}
                    valueColor={numUngradedAssignments > 0 ? '#D4A289' : undefined}
                    subtitle={ungradedSubtitle}
                  />
                </div>

                <GradingTabsCard
                  gradingProgress={gradingProgress}
                  assistantsProgress={assistantsProgress}
                />
              </>
            );
          }}
        </Await>
      </Suspense>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
        <Await resolve={cockpit} errorElement={null}>
          {(result) => {
            if (!result) return null;
            const [queue, throughput, streak, distribution] = result;
            return (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2">
                    <MyDayQueue queue={queue} />
                  </div>
                  <StreakBadge
                    days={streak.days}
                    lastGradedAt={streak.lastGradedAt}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <ThroughputSparkline data={throughput} />
                  <OwnVsClassHistogram
                    yours={distribution.yours}
                    classroom={distribution.classroom}
                  />
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
