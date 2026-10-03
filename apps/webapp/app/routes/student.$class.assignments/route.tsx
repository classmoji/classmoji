import { Suspense } from 'react';
import { Await } from 'react-router';
import { Skeleton } from 'antd';
import { namedAction } from 'remix-utils/named-action';
import { ClassmojiService, type StudentCourseworkRow } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { loadQuizzesVisible } from '~/utils/classroomProFlag.server';
import ProgressSummaryCard, { type BucketCounts } from './ProgressSummaryCard';
import AssignmentsTabsCard from './AssignmentsTabsCard';

interface AssignmentsData {
  classroomTitle: string;
  classroomSubtitle: string | null;
  counts: BucketCounts;
  rows: StudentCourseworkRow[];
  balance: number;
}

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
    const [rows, balance] = await Promise.all([
      // Every assignment the student can see, every type. Where quizzes are
      // hidden (not Pro, or switched off) no quiz row is built. The quiz answer
      // and the assignment listing are read together. A failed read is logged
      // and degrades to an empty list rather than failing the deferred render
      // (a failed quiz or form read alone already leaves the other rows).
      Promise.all([
        loadQuizzesVisible(classroom.id),
        ClassmojiService.studentCoursework.listPublishedAssignments(classroom.id),
      ])
        .then(([quizzesVisible, assignments]) =>
          ClassmojiService.studentCoursework.listForStudent({
            classroomId: classroom.id,
            classroomSlug: classSlug,
            userId,
            quizzesVisible,
            gitOrgLogin,
            assignments,
          })
        )
        .catch((error): StudentCourseworkRow[] => {
          console.error(
            '[student assignments] coursework read failed',
            { classroomId: classroom.id, userId },
            error
          );
          return [];
        }),
      ClassmojiService.token.getBalance(classroom.id, userId).catch(() => 0),
    ]);

    // An untracked row (a PUBLIC form, open or closed) is neither owed nor
    // done by this student, so it does not count toward their progress.
    const completed = rows.filter(r => r.tracked && r.done).length;
    const current = rows.filter(r => r.tracked && !r.done).length;
    const counts: BucketCounts = { completed, current, total: completed + current };

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
      // client-supplied `amount` is never trusted, and the popover's gates
      // (a price is set, no late override) are re-enforced there so they
      // cannot be bypassed by posting a crafted request body. It also checks
      // the submission is the paying student's own, or their team's
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
