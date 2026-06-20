import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';
import { namedAction } from 'remix-utils/named-action';
import dayjs from 'dayjs';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
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
  balance: number;
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
    const [repoAssignments, balance] = await Promise.all([
      ClassmojiService.helper
        .findAllAssignmentsForStudent(userId, classSlug)
        .catch(
          () =>
            [] as Awaited<ReturnType<typeof ClassmojiService.helper.findAllAssignmentsForStudent>>
        ),
      ClassmojiService.token.getBalance(classroom.id, userId).catch(() => 0),
    ]);

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
          gitOrgLogin && ra.git_repo?.name && ra.provider_issue_number
            ? `https://github.com/${gitOrgLogin}/${ra.git_repo.name}/issues/${ra.provider_issue_number}`
            : null;
        const gradersSummary = (ra.graders ?? [])
          .map(g => g.grader?.name)
          .filter(Boolean)
          .join(', ');

        // Late-hours: how many hours past the deadline the student still is, after
        // subtracting any extension hours they've already bought with tokens. Only
        // OPEN (not-yet-submitted) assignments can accrue late hours.
        const extensionHours = (ra.token_transactions ?? [])
          .filter(t => t.type === 'PURCHASE')
          .reduce((sum, t) => sum + (t.hours_purchased ?? 0), 0);
        const deadlineMs = ra.assignment?.student_deadline
          ? new Date(ra.assignment.student_deadline).getTime()
          : null;
        const hoursPastDeadline =
          deadlineMs !== null ? Math.max(0, Math.ceil((Date.now() - deadlineMs) / 3_600_000)) : 0;
        const numLateHours =
          ra.status === 'OPEN' ? Math.max(0, hoursPastDeadline - extensionHours) : 0;

        return {
          id: ra.id,
          assignmentTitle: ra.assignment?.title ?? 'Assignment',
          repositoryTitle: ra.git_repo?.repository?.title ?? '',
          moduleType: ra.git_repo?.repository?.type ?? null,
          status,
          gradesReleased: Boolean(ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0),
          studentDeadline: ra.assignment?.student_deadline
            ? new Date(ra.assignment.student_deadline).toISOString()
            : null,
          issueUrl,
          grades: (ra.grades ?? []).map(g => ({ id: g.id, emoji: g.emoji })),
          gradersSummary,
          numLateHours,
          isLateOverride: Boolean(ra.is_late_override),
          tokensPerHour: ra.assignment?.tokens_per_hour ?? 0,
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

    const subtitleParts = [gitOrgLogin].filter((p): p is string => Boolean(p));

    return {
      classroomTitle: classroom.name ?? 'Class',
      classroomSubtitle: subtitleParts.length ? subtitleParts.join(' · ') : null,
      counts,
      rows,
      balance,
    };
  })();

  return { data: dataPromise };
};

const StudentAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { data } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">
        Assignments
      </h1>

      <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
        <Await resolve={data} errorElement={null}>
          {(d: AssignmentsData) => (
            <div className="flex flex-col gap-5">
              <ProgressSummaryCard
                classroomTitle={d.classroomTitle}
                classroomSubtitle={d.classroomSubtitle}
                counts={d.counts}
              />
              <AssignmentsTabsCard rows={d.rows} balance={d.balance} />
            </div>
          )}
        </Await>
      </Suspense>
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const data = await request.json();
  const classSlug = params.class!;

  return namedAction(request, {
    async purchaseExtensionHours() {
      const { classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'TOKEN_PURCHASE',
        attemptedAction: 'purchase_extension_hours',
        metadata: {
          hours_requested: data.hours_purchased,
          repository_issue_id: data.repository_issue_id,
        },
        resourceOwnerId: data.student_id,
        selfAccessRoles: ['STUDENT'],
      });
      assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

      if (!data.hours_purchased || data.hours_purchased <= 0) {
        throw new Error('Invalid hours: Must be a positive number.');
      }
      if (!data.amount || data.amount >= 0) {
        throw new Error('Invalid amount: Token spending amount must be negative.');
      }
      if (!data.git_repo_assignment_id) {
        throw new Error('Missing repository assignment ID.');
      }
      if (String(data.classroom_id) !== String(classroom.id)) {
        throw new Error('Invalid classroom ID.');
      }

      await ClassmojiService.token.updateExtension(data);
      return {
        action: 'PURCHASE_EXTENSION_HOURS',
        success: 'Successfully purchased hour(s).',
      };
    },
  });
};

export default StudentAssignments;
