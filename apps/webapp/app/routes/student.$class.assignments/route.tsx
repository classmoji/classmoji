import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';
import dayjs from 'dayjs';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import ProgressSummaryCard, { type BucketCounts } from './ProgressSummaryCard';
import AssignmentsTabsCard, {
  type AssignmentRow,
  type AssignmentStatus,
} from './AssignmentsTabsCard';

interface AssignmentsData {
  classroomTitle: string;
  classroomSubtitle: string | null;
  counts: BucketCounts;
  rows: AssignmentRow[];
}

type RepoAssignment = Awaited<
  ReturnType<typeof ClassmojiService.helper.findAllAssignmentsForStudent>
>[number];

type ProgressBucket = 'graded' | 'submitted' | 'unlocked' | 'locked';

const classifyStatus = (ra: RepoAssignment): AssignmentStatus =>
  ra.status === 'CLOSED' ? 'completed' : 'current';

const classifyProgressBucket = (ra: RepoAssignment): ProgressBucket => {
  const now = Date.now();
  const releaseAt = ra.assignment?.release_at ? new Date(ra.assignment.release_at).getTime() : null;
  const notYetReleased = releaseAt !== null && releaseAt > now;
  const notPublished = ra.assignment?.is_published === false;

  if (ra.status === 'OPEN' && (notPublished || notYetReleased)) return 'locked';
  if (ra.status === 'OPEN') return 'unlocked';
  const hasReleasedGrades = Boolean(ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0);
  return hasReleasedGrades ? 'graded' : 'submitted';
};

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_ASSIGNMENTS',
    attemptedAction: 'view_assignments',
  });

  const gitOrgLogin = classroom.git_organization?.login ?? null;

  const dataPromise = (async (): Promise<AssignmentsData> => {
    const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
      userId,
      classSlug
    );

    // Deduplicate by assignment_id — team assignments can appear twice
    const byAssignmentId = new Map<string, RepoAssignment>();
    for (const ra of repoAssignments) {
      const key = ra.assignment_id ?? ra.id;
      if (!byAssignmentId.has(key)) byAssignmentId.set(key, ra);
    }
    const unique = Array.from(byAssignmentId.values());

    const rows: AssignmentRow[] = unique
      .filter(ra => ra.assignment?.is_published !== false)
      .map(ra => {
        const status = classifyStatus(ra);
        const issueUrl =
          gitOrgLogin && ra.repository?.name && ra.provider_issue_number
            ? `https://github.com/${gitOrgLogin}/${ra.repository.name}/issues/${ra.provider_issue_number}`
            : null;
        const gradersSummary = (ra.graders ?? [])
          .map(g => g.grader?.name)
          .filter(Boolean)
          .join(', ');
        return {
          id: ra.id,
          assignmentTitle: ra.assignment?.title ?? 'Assignment',
          moduleTitle: ra.repository?.module?.title ?? '',
          moduleType: ra.repository?.module?.type ?? null,
          status,
          gradesReleased: Boolean(ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0),
          studentDeadline: ra.assignment?.student_deadline
            ? new Date(ra.assignment.student_deadline).toISOString()
            : null,
          issueUrl,
          grades: (ra.grades ?? []).map(g => ({ id: g.id, emoji: g.emoji })),
          gradersSummary,
        };
      })
      .sort((a, b) => {
        // Current (OPEN) first, sorted by soonest deadline
        if (a.status !== b.status) return a.status === 'current' ? -1 : 1;
        const aT = a.studentDeadline ? dayjs(a.studentDeadline).valueOf() : Infinity;
        const bT = b.studentDeadline ? dayjs(b.studentDeadline).valueOf() : Infinity;
        return a.status === 'current' ? aT - bT : bT - aT;
      });

    const progressBuckets = unique
      .filter(ra => ra.assignment?.is_published !== false)
      .map(classifyProgressBucket);
    const counts: BucketCounts = {
      graded: progressBuckets.filter(b => b === 'graded').length,
      submitted: progressBuckets.filter(b => b === 'submitted').length,
      unlocked: progressBuckets.filter(b => b === 'unlocked').length,
      locked: progressBuckets.filter(b => b === 'locked').length,
      total: progressBuckets.length,
    };

    const termPretty = classroom.term
      ? String(classroom.term).charAt(0) + String(classroom.term).slice(1).toLowerCase()
      : null;
    const termLabel = [termPretty, classroom.year ? String(classroom.year) : null]
      .filter(Boolean)
      .join(' ');
    const subtitleParts = [gitOrgLogin, termLabel].filter((p): p is string => Boolean(p));

    return {
      classroomTitle: classroom.name ?? 'Class',
      classroomSubtitle: subtitleParts.length ? subtitleParts.join(' · ') : null,
      counts,
      rows,
    };
  })();

  return { data: dataPromise };
};

const StudentAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { data } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        Assignments
      </h1>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
        <Await resolve={data}>
          {(d: AssignmentsData) => (
            <div className="flex flex-col gap-5">
              <ProgressSummaryCard
                classroomTitle={d.classroomTitle}
                classroomSubtitle={d.classroomSubtitle}
                counts={d.counts}
              />
              <AssignmentsTabsCard rows={d.rows} />
            </div>
          )}
        </Await>
      </Suspense>
    </div>
  );
};

export default StudentAssignments;
