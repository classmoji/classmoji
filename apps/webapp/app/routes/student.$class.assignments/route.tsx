import { Suspense } from 'react';
import { gitContextFor, gitWeb } from '~/utils/gitWeb';
import { Await } from 'react-router';
import { Skeleton } from 'antd';
import { namedAction } from 'remix-utils/named-action';
import dayjs from 'dayjs';
import { ClassmojiService } from '@classmoji/services';
import { titleToIdentifier } from '@classmoji/utils';
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
  const web = gitWeb(gitContextFor(classroom));

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
        // The student's (or their team's) own copy of the repository. With the
        // student Repositories screen gone, this row is where they reach it.
        const repoUrl = gitOrgLogin && ra.git_repo?.name ? web.repo(ra.git_repo.name) : null;
        const issueUrl =
          repoUrl && ra.provider_issue_number
            ? `${repoUrl}/issues/${ra.provider_issue_number}`
            : null;
        const gradersSummary = (ra.graders ?? [])
          .map(g => g.grader?.name)
          .filter(Boolean)
          .join(', ');

        // Late-hours: how many hours past the deadline the student still is, after
        // subtracting any extension hours they've already bought with tokens. In
        // ISSUE mode only OPEN (not-yet-submitted) assignments accrue late hours;
        // in REPO mode the latest push is the submission, so a late push is late
        // by that push's time.
        const extensionHours = (ra.token_transactions ?? [])
          .filter(t => t.type === 'PURCHASE')
          .reduce((sum, t) => sum + (t.hours_purchased ?? 0), 0);
        const deadlineMs = ra.assignment?.student_deadline
          ? new Date(ra.assignment.student_deadline).getTime()
          : null;
        const isRepoMode = ra.assignment?.submission_mode === 'REPO';
        const submittedAtMs = isRepoMode && ra.closed_at ? new Date(ra.closed_at).getTime() : null;
        const hoursPastDeadline =
          deadlineMs !== null
            ? Math.max(0, Math.ceil(((submittedAtMs ?? Date.now()) - deadlineMs) / 3_600_000))
            : 0;
        const numLateHours =
          isRepoMode || ra.status === 'OPEN' ? Math.max(0, hoursPastDeadline - extensionHours) : 0;

        return {
          id: ra.id,
          assignmentTitle: ra.assignment?.title ?? 'Assignment',
          // Name it the way GitHub does: the student's own repo when it exists,
          // otherwise the repository's slug — the prefix theirs will be cut
          // under. The display title would not match what they open.
          repositoryTitle:
            ra.git_repo?.name ??
            ra.git_repo?.repository?.slug ??
            (ra.git_repo?.repository?.title ? titleToIdentifier(ra.git_repo.repository.title) : ''),
          moduleType: ra.git_repo?.repository?.type ?? null,
          status,
          gradesReleased: Boolean(ra.assignment?.grades_released && (ra.grades?.length ?? 0) > 0),
          studentDeadline: ra.assignment?.student_deadline
            ? new Date(ra.assignment.student_deadline).toISOString()
            : null,
          repoUrl,
          commitCount: ra.analytics_snapshot?.total_commits ?? null,
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
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Assignments</h1>

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

      const hoursPurchased = Number(data.hours_purchased);
      if (!Number.isInteger(hoursPurchased) || hoursPurchased <= 0) {
        throw new Error('Invalid hours: Must be a positive whole number.');
      }
      if (!data.git_repo_assignment_id) {
        throw new Error('Missing repository assignment ID.');
      }
      if (String(data.classroom_id) !== String(classroom.id)) {
        throw new Error('Invalid classroom ID.');
      }

      // Price and eligibility are recomputed server-side in the service — the
      // client-supplied `amount` is never trusted, and the deadline /
      // late-hour / override gates from the popover are re-enforced there so
      // they cannot be bypassed by posting a crafted request body
      // (packages/services token.purchaseExtensionHours, plan §5.2 gap 6).
      await ClassmojiService.token.purchaseExtensionHours({
        classroomId: classroom.id,
        studentId: data.student_id,
        gitRepoAssignmentId: data.git_repo_assignment_id,
        hours: hoursPurchased,
      });
      return {
        action: 'PURCHASE_EXTENSION_HOURS',
        success: 'Successfully purchased hour(s).',
      };
    },
  });
};

export default StudentAssignments;
