import { Suspense } from 'react';
import { gitContextFor } from '~/utils/gitWeb';
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
            git: gitContextFor(classroom),
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

/** The most hours one purchase buys; the same cap the MCP extension_purchase tool has. */
export const MAX_EXTENSION_HOURS = 1000;

/** A non-empty string id from the body, or null. */
const idFrom = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

export const action = async ({ request, params }: Route.ActionArgs) => {
  const data = await request.json();
  const classSlug = params.class!;

  return namedAction(request, {
    async purchaseExtensionHours() {
      // What the hours are bought on: a repo submission or a quiz assignment,
      // exactly one of the two.
      const gitRepoAssignmentId = idFrom(data.git_repo_assignment_id);
      const assignmentId = idFrom(data.assignment_id);
      const metadata = {
        hours_requested: data.hours_purchased,
        ...(gitRepoAssignmentId ? { git_repo_assignment_id: gitRepoAssignmentId } : {}),
        ...(assignmentId ? { assignment_id: assignmentId } : {}),
      };

      const checkBody = (classroomId: string) => {
        const hours = data.hours_purchased;
        if (
          typeof hours !== 'number' ||
          !Number.isInteger(hours) ||
          hours <= 0 ||
          hours > MAX_EXTENSION_HOURS
        ) {
          throw new Error(
            `Invalid hours: Must be a positive whole number, at most ${MAX_EXTENSION_HOURS}.`
          );
        }
        if (Boolean(gitRepoAssignmentId) === Boolean(assignmentId)) {
          throw new Error('Name one repository assignment or one quiz assignment.');
        }
        if (idFrom(data.classroom_id) !== classroomId) {
          throw new Error('Invalid classroom ID.');
        }
        return hours;
      };

      // Price and eligibility are recomputed server-side in the service: the
      // client never sends a price, and every gate (a price is set, a
      // deadline, no late override on a repo, the submission or quiz is the
      // student's to extend) is re-enforced there so it cannot be bypassed by
      // posting a crafted request body.

      if (assignmentId && !gitRepoAssignmentId) {
        // A quiz: students buy hours for themselves only. The payer is the
        // signed-in student (their STUDENT membership); a body naming anyone
        // else is refused by the gate (and audited) and again below.
        const claimed = data.student_id;
        if (claimed !== undefined && claimed !== null && !idFrom(claimed)) {
          throw new Error('Invalid student ID.');
        }
        const { userId, classroom, membership } = await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['STUDENT'],
          resourceType: 'TOKEN_PURCHASE',
          attemptedAction: 'purchase_extension_hours',
          metadata,
          ...(idFrom(claimed) ? { resourceOwnerId: claimed, requireOwnership: true } : {}),
        });
        if (idFrom(claimed) && claimed !== userId) {
          throw new Response('Forbidden', { status: 403 });
        }
        assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
        const hours = checkBody(classroom.id);

        await ClassmojiService.token.purchaseQuizExtensionHours({
          classroomId: classroom.id,
          studentId: userId,
          assignmentId,
          hours,
        });
      } else {
        // A repo submission: the student themselves, or staff on their behalf.
        const studentId = idFrom(data.student_id);
        if (!studentId) {
          throw new Error('Invalid student ID.');
        }
        const { classroom, membership } = await assertClassroomAccess({
          request,
          classroomSlug: classSlug,
          allowedRoles: ['OWNER', 'TEACHER'],
          resourceType: 'TOKEN_PURCHASE',
          attemptedAction: 'purchase_extension_hours',
          metadata,
          resourceOwnerId: studentId,
          selfAccessRoles: ['STUDENT'],
        });
        assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
        const hours = checkBody(classroom.id);

        await ClassmojiService.token.purchaseExtensionHours({
          classroomId: classroom.id,
          studentId,
          gitRepoAssignmentId: gitRepoAssignmentId!,
          hours,
        });
      }
      return {
        action: 'PURCHASE_EXTENSION_HOURS',
        success: 'Successfully purchased hour(s).',
      };
    },
  });
};

export default StudentAssignments;
