import dayjs from 'dayjs';
import { Suspense, useState } from 'react';
import { Await, Link, useParams } from 'react-router';
import { Skeleton } from 'antd';
import { IconAlertCircle, IconX } from '@tabler/icons-react';
import getPrisma from '@classmoji/database';

import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import SubmissionChart from './SubmissionChart';
import Leaderboard from './Leaderboard';
import GradingTabsCard from './GradingTabsCard';
import {
  AssignmentHeatmap,
  TAOpsTable,
  AtRiskStudents,
  QuizAnalytics,
  DeadlinePressure,
} from '~/components/features/dashboard';
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

  const gitOrgLogin = classroom.git_organization?.login;
  let githubOrganization = null;
  if (gitOrgLogin && classroom.git_organization?.github_installation_id) {
    try {
      const gitProvider = getGitProvider(classroom.git_organization);
      githubOrganization = await gitProvider.getOrganization(gitOrgLogin);
    } catch {
      // GitHub API unavailable; ignore for banner.
    }
  }

  const prisma = getPrisma();
  const totalRepoAssignmentsPromise = prisma.repositoryAssignment.count({
    where: { repository: { classroom: { slug: classSlug! } } },
  });
  const submittedRepoAssignmentsPromise = prisma.repositoryAssignment.count({
    where: {
      repository: { classroom: { slug: classSlug! } },
      status: 'CLOSED',
    },
  });
  const lateRepoAssignmentsPromise = prisma.repositoryAssignment
    .findMany({
      where: { repository: { classroom: { slug: classSlug! } } },
      include: { assignment: true },
    })
    .then(list => (list as Array<{ is_late: boolean }>).filter(r => r.is_late).length);

  const promises = {
    students: ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT'),
    leaderbord: ClassmojiService.helper.calculateClassLeaderboard(classSlug!),
    gradingProgress: ClassmojiService.repositoryAssignment.getGradingProgress(classSlug!),
    completedAssignmentsProgress: ClassmojiService.repositoryAssignment.getCompletionProgress(
      classSlug!
    ),
    lateSubmissionsPercent: ClassmojiService.repositoryAssignment.getLatePercentage(classSlug!),
    recentRepositoryAssignments: ClassmojiService.repositoryAssignment.findRecentlyClosed(
      classSlug!,
      dayjs().subtract(10, 'day').toDate(),
      dayjs().toDate()
    ),
    gradingProgressPerAssignment: ClassmojiService.helper.findClassroomGradingProgressPerAssignment(
      classroom.id
    ),
    assistantsProgress: ClassmojiService.repositoryAssignmentGrader.findGradersProgress(
      classroom.id
    ),
    totalRepoAssignments: totalRepoAssignmentsPromise,
    submittedRepoAssignments: submittedRepoAssignmentsPromise,
    lateRepoAssignments: lateRepoAssignmentsPromise,
  };

  const analyticsPromise = Promise.all([
    ClassmojiService.dashboard.assignmentHealth(classroom.id),
    ClassmojiService.dashboard.taOps(classroom.id),
    ClassmojiService.dashboard.cohortOverview(classroom.id),
    ClassmojiService.dashboard.quizAnalytics(classroom.id),
    ClassmojiService.dashboard.deadlinePressure(classroom.id),
  ]).catch(() => null);

  return {
    data: Promise.all(Object.values(promises)),
    analytics: analyticsPromise,
    githubOrganization,
  };
};

interface StatItemProps {
  label: string;
  value: string | number;
  subtitle?: string;
  valueColor?: string;
  accent?: React.ReactNode;
}

const StatItem = ({ label, value, subtitle, valueColor, accent }: StatItemProps) => (
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
    {accent && <div className="shrink-0 self-center">{accent}</div>}
  </div>
);

const RingChart = ({ pct, color }: { pct: number; color: string }) => {
  const size = 44;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#F1F0EC"
        strokeWidth={stroke}
        className="dark:stroke-gray-800"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

const AdminDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data, analytics, githubOrganization } = loaderData;
  const { class: classSlug } = useParams();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const showBanner =
    !bannerDismissed && githubOrganization?.default_repository_permission !== 'none';

  return (
    <div className="min-h-full flex flex-col gap-4">
      <h1 className="mt-2 mb-1 text-base font-semibold text-gray-600 dark:text-gray-400">
        Dashboard
      </h1>

      {showBanner && (
        <div className="flex items-start gap-3 rounded-xl bg-[#FEF3EC] dark:bg-amber-900/20 border border-[#F4D8C5] dark:border-amber-800/40 px-4 py-3 text-sm text-[#8a5b3a] dark:text-amber-200">
          <IconAlertCircle size={18} className="shrink-0 mt-0.5" />
          <div className="flex-1">
            Students can see each other&apos;s repositories.{' '}
            <Link
              to={`/admin/${classSlug}/settings/repos`}
              className="font-semibold underline underline-offset-2"
            >
              Go to Settings
            </Link>{' '}
            to disable.
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBannerDismissed(true)}
            className="shrink-0 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <IconX size={16} />
          </button>
        </div>
      )}

      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {([
            students,
            leaderbord,
            gradingProgress,
            completedAssignmentsProgress,
            lateSubmissionsPercent,
            recentRepositoryAssignments,
            gradingProgressPerAssignment,
            assistantsProgress,
            totalRepoAssignments,
            submittedRepoAssignments,
            lateRepoAssignments,
          ]) => {
            const submittedSubtitle = totalRepoAssignments
              ? `${submittedRepoAssignments} of ${totalRepoAssignments} assignments`
              : 'no assignments yet';
            const lateSubtitle = lateRepoAssignments
              ? `${lateRepoAssignments} late submission${lateRepoAssignments === 1 ? '' : 's'}`
              : 'no late submissions';

            return (
              <>
                <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 overflow-hidden flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-stone-200/70 dark:divide-gray-800">
                  <StatItem
                    label="Students"
                    value={students?.length || 0}
                    subtitle="enrolled"
                  />
                  <StatItem
                    label="Submitted"
                    value={`${completedAssignmentsProgress || 0}%`}
                    valueColor="#619462"
                    subtitle={submittedSubtitle}
                  />
                  <StatItem
                    label="Late"
                    value={`${lateSubmissionsPercent || 0}%`}
                    subtitle={lateSubtitle}
                  />
                  <StatItem
                    label="Grading"
                    value={`${gradingProgress || 0}%`}
                    valueColor="#D4A289"
                    accent={<RingChart pct={gradingProgress || 0} color="#D4A289" />}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        Submissions
                      </h3>
                      <span className="text-[11px] text-gray-500 dark:text-gray-400">
                        Last 10 days
                      </span>
                    </div>
                    <div className="h-[340px] sm:h-[380px]">
                      <SubmissionChart
                        recentRepositoryAssignments={recentRepositoryAssignments || []}
                      />
                    </div>
                  </section>
                  <Leaderboard students={leaderbord} />
                </div>

                <GradingTabsCard
                  gradingProgress={gradingProgressPerAssignment}
                  assistantsProgress={assistantsProgress}
                />
              </>
            );
          }}
        </Await>
      </Suspense>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
        <Await resolve={analytics} errorElement={null}>
          {(result) => {
            if (!result) return null;
            const [assignments, taOps, cohort, quiz, deadlines] = result;
            return (
              <>
                <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                    Assignment health
                  </h3>
                  <AssignmentHeatmap rows={assignments} />
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                      TA operations
                    </h3>
                    <TAOpsTable rows={taOps} />
                  </section>
                  <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                      At-risk students
                    </h3>
                    <AtRiskStudents
                      atRiskCount={cohort.atRiskCount}
                      students={cohort.atRiskStudents}
                    />
                  </section>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                      Quiz analytics
                    </h3>
                    <QuizAnalytics data={quiz} />
                  </section>
                  <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                      Deadline pressure
                    </h3>
                    <DeadlinePressure buckets={deadlines} />
                  </section>
                </div>
              </>
            );
          }}
        </Await>
      </Suspense>
    </div>
  );
};

export default AdminDashboard;
