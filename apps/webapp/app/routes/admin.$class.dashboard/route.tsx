import dayjs from 'dayjs';
import { Suspense, useEffect, useState } from 'react';
import { animate, motion, useReducedMotion } from 'framer-motion';
import { Await, Link, useParams } from 'react-router';
import { Skeleton } from 'antd';
import { IconAlertCircle, IconX } from '@tabler/icons-react';
import getPrisma from '@classmoji/database';

import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { EASE_OUT_QUINT } from '~/utils/motion';
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
  const totalRepoAssignmentsPromise = prisma.gitRepoAssignment.count({
    where: { git_repo: { classroom: { slug: classSlug! } } },
  });
  const submittedRepoAssignmentsPromise = prisma.gitRepoAssignment.count({
    where: {
      git_repo: { classroom: { slug: classSlug! } },
      status: 'CLOSED',
    },
  });
  const lateRepoAssignmentsPromise = prisma.gitRepoAssignment
    .findMany({
      where: { git_repo: { classroom: { slug: classSlug! } } },
      select: {
        closed_at: true,
        is_late_override: true,
        assignment: { select: { student_deadline: true } },
      },
    })
    .then(
      list =>
        list.filter(
          r =>
            r.is_late_override ||
            Boolean(
              r.closed_at &&
              r.assignment.student_deadline &&
              r.closed_at > r.assignment.student_deadline
            )
        ).length
    );

  const dataPromise = Promise.all([
    ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT'),
    ClassmojiService.helper.calculateClassLeaderboard(classSlug!),
    ClassmojiService.gitRepoAssignment.getGradingProgress(classSlug!),
    ClassmojiService.gitRepoAssignment.getCompletionProgress(classSlug!),
    ClassmojiService.gitRepoAssignment.getLatePercentage(classSlug!),
    ClassmojiService.gitRepoAssignment.findRecentlyClosed(
      classSlug!,
      dayjs().subtract(10, 'day').toDate(),
      dayjs().toDate()
    ),
    ClassmojiService.helper.findClassroomGradingProgressPerAssignment(classroom.id),
    ClassmojiService.gitRepoAssignmentGrader.findGradersProgress(classroom.id),
    totalRepoAssignmentsPromise,
    submittedRepoAssignmentsPromise,
    lateRepoAssignmentsPromise,
  ] as const);

  const analyticsPromise = Promise.all([
    ClassmojiService.dashboard.assignmentHealth(classroom.id),
    ClassmojiService.dashboard.taOps(classroom.id),
    ClassmojiService.dashboard.cohortOverview(classroom.id),
    ClassmojiService.dashboard.quizAnalytics(classroom.id),
    ClassmojiService.dashboard.deadlinePressure(classroom.id),
  ]).catch(() => null);

  return {
    data: dataPromise,
    analytics: analyticsPromise,
    githubOrganization,
  };
};
const statsContainerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const statItemVariants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE_OUT_QUINT } },
};

// Counts a number up from 0 to `value` on mount; static when reduced motion is on.
const AnimatedNumber = ({ value, suffix }: { value: number; suffix?: string }) => {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 1.4,
      ease: EASE_OUT_QUINT,
      onUpdate: latest => setDisplay(Math.round(latest)),
    });
    return () => controls.stop();
  }, [value, reduced]);

  return (
    <>
      {display}
      {suffix}
    </>
  );
};

interface StatItemProps {
  label: string;
  value: number;
  suffix?: string;
  subtitle?: string;
  valueColor?: string;
  accent?: React.ReactNode;
}

const StatItem = ({ label, value, suffix, subtitle, valueColor, accent }: StatItemProps) => (
  <motion.div
    variants={statItemVariants}
    className="flex-1 min-w-0 flex items-start justify-between gap-3 px-4 sm:px-5 py-4"
  >
    <div className="min-w-0">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div
        className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight leading-tight"
        style={valueColor ? { color: valueColor } : undefined}
      >
        <AnimatedNumber value={value} suffix={suffix} />
      </div>
      {subtitle && (
        <div className="mt-0.5 text-xs text-ink-3 truncate">
          {subtitle}
        </div>
      )}
    </div>
    {accent && <div className="shrink-0 self-center">{accent}</div>}
  </motion.div>
);

const RingChart = ({ pct, color }: { pct: number; color: string }) => {
  const reduced = useReducedMotion();
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
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={reduced ? false : { strokeDashoffset: c }}
        animate={{ strokeDashoffset: c - dash }}
        transition={reduced ? undefined : { duration: 1.3, ease: EASE_OUT_QUINT, delay: 0.25 }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

const AdminDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data, analytics, githubOrganization } = loaderData;
  const { class: classSlug } = useParams();
  const reducedMotion = useReducedMotion();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const showBanner =
    !bannerDismissed && githubOrganization?.default_repository_permission !== 'none';

  return (
    <div className="min-h-full flex flex-col gap-4">
      <h1 className="mt-2 mb-1 text-base font-semibold text-ink-2">
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
                <motion.div
                  data-tour="dashboard-stats"
                  variants={reducedMotion ? undefined : statsContainerVariants}
                  initial={reducedMotion ? false : 'hidden'}
                  animate={reducedMotion ? false : 'show'}
                  className="rounded-2xl bg-panel ring-1 ring-line overflow-hidden flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-line"
                >
                  <StatItem label="Students" value={students?.length || 0} subtitle="enrolled" />
                  <StatItem
                    label="Submitted"
                    value={completedAssignmentsProgress || 0}
                    suffix="%"
                    valueColor="#619462"
                    subtitle={submittedSubtitle}
                  />
                  <StatItem
                    label="Late"
                    value={lateSubmissionsPercent || 0}
                    suffix="%"
                    subtitle={lateSubtitle}
                  />
                  <StatItem
                    label="Grading"
                    value={gradingProgress || 0}
                    suffix="%"
                    valueColor="#D4A289"
                    accent={<RingChart pct={gradingProgress || 0} color="#D4A289" />}
                  />
                </motion.div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <section className="rounded-2xl bg-panel ring-1 ring-line p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-ink-0">
                        Submissions
                      </h3>
                      <span className="text-xs text-ink-3">
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
          {result => {
            if (!result) return null;
            const [assignments, taOps, cohort, quiz, deadlines] = result;
            return (
              <>
                <AssignmentHeatmap rows={assignments} />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <TAOpsTable rows={taOps} />
                  <AtRiskStudents
                    atRiskCount={cohort.atRiskCount}
                    students={cohort.atRiskStudents}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <QuizAnalytics data={quiz} />
                  <DeadlinePressure buckets={deadlines} />
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
