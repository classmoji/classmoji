import { Suspense } from 'react';
import { Await, Link } from 'react-router';
import { Card, Skeleton } from 'antd';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import {
  AssignmentHeatmap,
  TAOpsTable,
  AtRiskStudents,
  QuizAnalytics,
  DeadlinePressure,
  KpiTile,
} from '~/components/features/dashboard';
import type { AssignmentHealthRow } from '~/components/features/dashboard';
import type { TaOpsRow } from '~/components/features/dashboard';
import type { AtRiskStudent } from '~/components/features/dashboard';
import type { QuizAnalyticsData } from '~/components/features/dashboard';
import type { DeadlineBucket } from '~/components/features/dashboard';
import SubmissionChart from './SubmissionChart';
import type { Route } from './+types/route';

interface CohortOverviewShape {
  activeStudents: number;
  inactiveStudents: number;
  medianGrade: number | null;
  atRiskCount: number;
  atRiskStudents: AtRiskStudent[];
  activeStudentsSeries: number[];
  submissionRateSeries: number[];
  slaSeriesHours: number[];
  atRiskSeries: number[];
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'DASHBOARD',
    action: 'view_dashboard',
  });

  if (!classroom) {
    throw new Response('Classroom not found', { status: 404 });
  }

  // Defer everything so the shell renders instantly and each panel streams in.
  const cohortPromise = ClassmojiService.dashboard.cohortOverview(classroom.id);
  const assignmentsPromise = ClassmojiService.dashboard.assignmentHealth(classroom.id);
  const taOpsPromise = ClassmojiService.dashboard.taOps(classroom.id);
  const quizPromise = ClassmojiService.dashboard.quizAnalytics(classroom.id);
  const deadlinesPromise = ClassmojiService.dashboard.deadlinePressure(classroom.id);
  const recentSubmissionsPromise = ClassmojiService.repositoryAssignment.findByClassroomId(
    classroom.id,
  );

  // Derived SLA metric: median TTG across all assignments in hours.
  const slaPromise = assignmentsPromise.then((rows) => {
    const ttgs = rows
      .map((r) => r.medianTimeToGradeHours)
      .filter((v): v is number => v !== null);
    if (ttgs.length === 0) return null;
    const sorted = [...ttgs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  });

  return {
    classSlug: classSlug!,
    cohort: cohortPromise,
    assignments: assignmentsPromise,
    taOps: taOpsPromise,
    quiz: quizPromise,
    deadlines: deadlinesPromise,
    recentSubmissions: recentSubmissionsPromise,
    sla: slaPromise,
  };
};

const PanelSkeleton = ({ height = 240 }: { height?: number }) => (
  <Card className="h-full">
    <Skeleton active paragraph={{ rows: Math.max(2, Math.round(height / 40)) }} />
  </Card>
);

const AdminDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { classSlug, cohort, assignments, taOps, quiz, deadlines, recentSubmissions, sla } =
    loaderData;

  return (
    <div className="flex flex-col gap-4" data-testid="owner-dashboard">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <Link
          to={`/admin/${classSlug}/grades`}
          className="text-sm text-primary-600 dark:text-primary-400 hover:underline"
        >
          Open Grading Queue →
        </Link>
      </div>

      {/* Row 1: four stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Suspense
          fallback={
            <>
              <PanelSkeleton height={100} />
              <PanelSkeleton height={100} />
              <PanelSkeleton height={100} />
              <PanelSkeleton height={100} />
            </>
          }
        >
          <Await resolve={Promise.all([cohort, sla])}>
            {(resolved: unknown) => {
              const [cohortData, slaHours] = resolved as [
                CohortOverviewShape,
                number | null,
              ];
              const subRate = cohortData.submissionRateSeries;
              const latestSubRate = subRate.length > 0 ? subRate[subRate.length - 1] : 0;
              const sla = cohortData.slaSeriesHours;
              const slaFirst = sla.length > 0 ? sla[0] : 0;
              const slaLast = sla.length > 0 ? sla[sla.length - 1] : 0;
              const slaImproved = slaLast < slaFirst;
              const slaDeltaAbs = Math.abs(slaLast - slaFirst);
              const atRisk = cohortData.atRiskSeries;
              const atRiskPrev = atRisk.length >= 2 ? atRisk[atRisk.length - 2] : 0;
              const atRiskLast = atRisk.length > 0 ? atRisk[atRisk.length - 1] : 0;
              const atRiskDiff = atRiskLast - atRiskPrev;
              return (
                <>
                  <KpiTile
                    label="Active Students"
                    value={cohortData.activeStudents}
                    sub="Past 14 days"
                    series={cohortData.activeStudentsSeries}
                  />
                  <KpiTile
                    label="Avg Submission Rate"
                    value={Math.round(latestSubRate * 100)}
                    suffix="%"
                    sub="Latest week"
                    series={cohortData.submissionRateSeries.map((v) => v * 100)}
                  />
                  <KpiTile
                    label="Grading SLA"
                    value={slaHours === null ? '—' : Number(slaHours.toFixed(1))}
                    suffix={slaHours === null ? '' : 'h'}
                    sub="Median time-to-grade"
                    delta={
                      sla.length >= 2 && slaDeltaAbs > 0.05
                        ? {
                            text: `${slaImproved ? '−' : '+'}${slaDeltaAbs.toFixed(1)}h`,
                            dir: slaImproved ? 'up' : 'down',
                          }
                        : undefined
                    }
                    series={cohortData.slaSeriesHours}
                  />
                  <KpiTile
                    label="Risk Students"
                    value={cohortData.atRiskCount}
                    sub="≥2 missed deadlines"
                    delta={
                      atRiskDiff !== 0
                        ? {
                            text: `${atRiskDiff > 0 ? '+' : ''}${atRiskDiff} this week`,
                            dir: atRiskDiff > 0 ? 'down' : 'up',
                          }
                        : undefined
                    }
                    series={cohortData.atRiskSeries}
                  />
                </>
              );
            }}
          </Await>
        </Suspense>
      </div>

      {/* Row 2: Submission chart + Assignment heatmap */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="h-full" data-testid="submission-history">
          <div className="flex items-center mb-4">
            <div className="w-1 h-6 bg-primary mr-3 rounded-full" />
            <h2 className="text-[16px] font-bold text-black dark:text-gray-200">
              Submission History
            </h2>
          </div>
          <div className="h-[300px]">
            <Suspense fallback={<Skeleton active />}>
              <Await resolve={recentSubmissions}>
                {(resolved: unknown) => {
                  const rows = resolved as Array<{ closed_at?: string | Date | null }>;
                  const recent = rows.filter((r) => r.closed_at) as Array<{
                    closed_at: string | Date;
                  }>;
                  return <SubmissionChart recentRepositoryAssignments={recent} />;
                }}
              </Await>
            </Suspense>
          </div>
        </Card>

        <Suspense fallback={<PanelSkeleton height={360} />}>
          <Await resolve={assignments}>
            {(resolved: unknown) => (
              <AssignmentHeatmap rows={resolved as AssignmentHealthRow[]} />
            )}
          </Await>
        </Suspense>
      </div>

      {/* Row 3: TA ops + At-risk students */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Suspense fallback={<PanelSkeleton height={360} />}>
          <Await resolve={taOps}>
            {(resolved: unknown) => <TAOpsTable rows={resolved as TaOpsRow[]} />}
          </Await>
        </Suspense>

        <Suspense fallback={<PanelSkeleton height={360} />}>
          <Await resolve={cohort}>
            {(resolved: unknown) => {
              const c = resolved as CohortOverviewShape;
              return (
                <AtRiskStudents atRiskCount={c.atRiskCount} students={c.atRiskStudents} />
              );
            }}
          </Await>
        </Suspense>
      </div>

      {/* Row 4: Quiz analytics + Deadline pressure */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Suspense fallback={<PanelSkeleton height={260} />}>
          <Await resolve={quiz}>
            {(resolved: unknown) => <QuizAnalytics data={resolved as QuizAnalyticsData} />}
          </Await>
        </Suspense>

        <Suspense fallback={<PanelSkeleton height={260} />}>
          <Await resolve={deadlines}>
            {(resolved: unknown) => (
              <DeadlinePressure buckets={resolved as DeadlineBucket[]} />
            )}
          </Await>
        </Suspense>
      </div>
    </div>
  );
};

export default AdminDashboard;
