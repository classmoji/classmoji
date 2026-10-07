import { Await, Outlet } from 'react-router';
import { Suspense } from 'react';
import { Skeleton } from 'antd';

import GradesTable from './GradesTable';
import { ClassmojiService } from '@classmoji/services';
import { quizStanding, type GradedItem } from '@classmoji/utils';
import { addAuditLog, addClassroomAuditLog } from '~/utils/helpers';
import { pickOwnerOnlyContactFields } from '~/utils/studentFields.server';
import {
  requireClassroomAdmin,
  requireClassroomStaff,
  assertClassroomMutationAllowed,
} from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/** A grade item as the table reads it, and nothing more. */
const projectGradedItem = (item: GradedItem): GradedItem => ({
  assignment_id: item.assignment_id,
  module_id: item.module_id,
  weight: item.weight,
  is_extra_credit: item.is_extra_credit,
  grade: item.grade,
  raw_grade: item.raw_grade,
  counts_as_zero: item.counts_as_zero,
  late_hours: item.late_hours,
  counting_raw_percentage: item.counting_raw_percentage,
});

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  // OWNER and TEACHER. Letter grades are a teaching-staff surface rather than
  // an owner-only one, and this route is served under both the /admin and
  // /teacher prefixes.
  const { classroom, membership } = await requireClassroomStaff(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'view_grades',
  });

  // `membership.role` is the caller's HIGHEST role in this classroom, resolved
  // in privilege order — an owner who also holds another role here still
  // resolves as OWNER. Same split the roster route applies, and the contact
  // trio is shared with it so the two cannot drift.
  const isRealOwner = membership?.role === 'OWNER';

  // One answer for the quiz columns AND the quiz grade items in the totals, the
  // same predicate the student report and the leaderboard use. A failed lookup
  // rejects (the page errors) rather than silently dropping quizzes out of
  // every total.
  const quizzesVisible = ClassmojiService.entitlement.quizzesVisibleOrThrow(classroom.id);

  // Each student's quiz grade items (user id → items), one batched read for the
  // roster. Projected to the item fields so nothing else reaches the page.
  const quizItems = quizzesVisible.then(visible =>
    ClassmojiService.quizGradeItems.loadQuizGradeItems({
      classroomId: classroom.id,
      quizzesVisible: visible,
    })
  );

  const promises = {
    emojiMappings: ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    // Modules, in course order: the grid groups its columns under them.
    modules: ClassmojiService.module
      .findByClassroomSlug(classSlug!)
      .then(modules => modules.map(m => ({ id: m.id, title: m.title, position: m.position }))),
    // Everything below is serialised to the browser, so each source is
    // projected down to the fields the table renders. The services return whole
    // `User` and `ClassroomMembership` rows — which carry contact details, the
    // global better-auth role, ban state and the Stripe customer id — and none
    // of that belongs in a page.
    students: Promise.all([
      ClassmojiService.user.findRepositoriesPerStudent(classroom),
      quizItems,
    ]).then(([students, itemsByUser]) =>
      students.map(student => ({
        id: student.id,
        name: student.name,
        login: student.login,
        // UserThumbnailView reads `avatar_url`; the User column is `image`.
        // Without the mapping the table rendered no avatars at all.
        avatar_url: student.image,
        // Passed through whole and untouched: calculateStudentFinalGrade
        // walks the nested assignments, grades and token transactions.
        git_repos: student.git_repos,
        // Quiz assignments in the totals: the same items the leaderboard and
        // the student report count.
        quiz_items: (itemsByUser.get(student.id) ?? []).map(projectGradedItem),
        ...pickOwnerOnlyContactFields(student, isRealOwner),
      }))
    ),
    // The table reads exactly one field out of the settings row — the late
    // penalty used by calculateStudentFinalGrade.
    settings: ClassmojiService.classroom
      .getClassroomSettingsForServer(classroom.id)
      .then(settings => ({
        late_penalty_points_per_hour: settings?.late_penalty_points_per_hour ?? 0,
      })),
    letterGradeMappings: ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id),
    // STUDENT rows only. ClassroomMembership is unique on
    // (classroom_id, user_id, role), so one person routinely holds several rows
    // in the same classroom — and the table joins these to students by
    // `user_id` with a `find`. Handed every role, that find could return a
    // teaching-staff row for a dual-role user, which would both display the
    // wrong grade and send that row's id back as the write target.
    memberships: ClassmojiService.classroomMembership
      .findByClassroomId(classroom.id, 'STUDENT')
      .then(memberships =>
        memberships.map(m => ({
          id: m.id,
          user_id: m.user_id,
          letter_grade: m.letter_grade,
        }))
      ),
    // The columns: every published assignment, grouped under its module in the
    // grid (module order, then creation order). Grading weight lives here.
    // Where quizzes are hidden their assignments are no column at all, so the
    // attempt lookups below never run for them either.
    assignments: Promise.all([
      ClassmojiService.assignment.listForClassroom(classroom.id, { publishedOnly: true }),
      quizzesVisible,
    ]).then(([assignments, showQuizzes]) =>
      assignments
        .filter(a => showQuizzes || a.type !== 'QUIZ')
        .map(a => ({
          id: a.id,
          title: a.title,
          weight: a.weight,
          is_extra_credit: a.is_extra_credit,
          type: a.type,
          module_id: a.module_id,
          module_title: a.module?.title,
          repository_id: a.repository_id,
          quiz_id: a.quiz_id,
          form_id: a.form_id,
          student_deadline: a.student_deadline,
          // A quiz column reads "Opens <date>" until it opens.
          release_at: a.release_at,
          created_at: a.created_at,
          submission_mode: a.submission_mode,
          grades_released: a.grades_released,
        }))
    ),
  };

  // Quiz and form assignments have no submission row; their per-student state
  // comes from attempts and responses, one query per assignment, keyed by
  // assignment id then user id.
  const activity = promises.assignments.then(async assignments => {
    const quiz: Record<string, Record<string, { completed: boolean; score: number | null }>> = {};
    const form: Record<string, Record<string, { submitted: boolean }>> = {};
    const quizIds = assignments.flatMap(a => (a.type === 'QUIZ' && a.quiz_id ? [a.quiz_id] : []));
    const gradingStrategies =
      quizIds.length > 0 ? ClassmojiService.quiz.findGradingStrategies(quizIds) : null;
    await Promise.all(
      assignments.map(async a => {
        if (a.type === 'QUIZ' && a.quiz_id) {
          const [attempts, strategies] = await Promise.all([
            ClassmojiService.quizAttempt.findByQuiz(a.quiz_id),
            gradingStrategies,
          ]);
          const byUser = new Map<string, typeof attempts>();
          for (const attempt of attempts) {
            byUser.set(attempt.user_id, [...(byUser.get(attempt.user_id) ?? []), attempt]);
          }
          // Each student's counting attempt under the quiz's grading strategy
          // (the shared selector): completed attempts only, scored by
          // partial_credit_percentage, so a running retake never hides a
          // finished attempt. Cell states only (in progress, unscored); the
          // totals, sorter and column mean read the grade items.
          quiz[a.id] = {};
          for (const [userId, own] of byUser) {
            const standing = quizStanding(own, strategies?.[a.quiz_id]);
            quiz[a.id][userId] = { completed: standing.completed, score: standing.score };
          }
        } else if (a.type === 'FORM' && a.form_id) {
          const responses = await ClassmojiService.formResponse.listByFormId(a.form_id);
          form[a.id] = {};
          for (const r of responses) {
            if (!r.user_id) continue;
            const submitted = r.submission_state === 'SUBMITTED';
            form[a.id][r.user_id] = {
              submitted: submitted || form[a.id][r.user_id]?.submitted || false,
            };
          }
        }
      })
    );
    return { quiz, form };
  });

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'CLASS_GRADES_SCREEN',
  });

  return {
    allData: Promise.all([...Object.values(promises), activity]),
    // Whether students see their final grade, and whether this viewer may
    // release or hide it (the action holds the owner gate itself).
    finalGradesReleased: classroom.settings?.final_grades_released === true,
    canReleaseFinalGrades: isRealOwner,
  };
};

const Grades = ({ loaderData }: Route.ComponentProps) => {
  const { allData, finalGradesReleased, canReleaseFinalGrades } = loaderData;

  return (
    <>
      <Outlet />
      <Suspense
        fallback={
          <div className="min-h-full">
            <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Grades</h1>
            <Skeleton active />
          </div>
        }
      >
        <Await resolve={allData} errorElement={null}>
          {([
            resolvedEmojiMappings,
            resolvedModules,
            resolvedStudents,
            resolvedSettings,
            resolvedLetterGradeMappings,
            resolvedMemberships,
            resolvedAssignments,
            resolvedActivity,
          ]) => (
            <GradesTable
              emojiMappings={
                resolvedEmojiMappings as Parameters<typeof GradesTable>[0]['emojiMappings']
              }
              modules={resolvedModules as Parameters<typeof GradesTable>[0]['modules']}
              assignments={resolvedAssignments as Parameters<typeof GradesTable>[0]['assignments']}
              students={
                resolvedStudents as unknown as Parameters<typeof GradesTable>[0]['students']
              }
              settings={resolvedSettings as Parameters<typeof GradesTable>[0]['settings']}
              letterGradeMappings={
                resolvedLetterGradeMappings as Parameters<
                  typeof GradesTable
                >[0]['letterGradeMappings']
              }
              memberships={resolvedMemberships as Parameters<typeof GradesTable>[0]['memberships']}
              activity={resolvedActivity as Parameters<typeof GradesTable>[0]['activity']}
              finalGradesReleased={finalGradesReleased}
              canReleaseFinalGrades={canReleaseFinalGrades}
            />
          )}
        </Await>
      </Suspense>
    </>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  // Same OWNER+TEACHER list as the loader. This action carries its own gate —
  // a layout loader does not gate it, because React Router runs the leaf action
  // before any loader.
  const { userId, classroom, membership } = await requireClassroomStaff(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'update_grades',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  if (data?.intent === 'set-final-grades-released') {
    return setFinalGradesReleased(request, classSlug!, data.final_grades_released);
  }

  const membershipId = typeof data?.membership_id === 'string' ? data.membership_id : null;
  const rawLetterGrade = data?.letter_grade;
  const letterGradeIsValid =
    rawLetterGrade === undefined || rawLetterGrade === null || typeof rawLetterGrade === 'string';

  if (!membershipId || !letterGradeIsValid) {
    return { error: 'Invalid request.' };
  }

  // Authorization binds to `params.class`, but the membership id arrives in the
  // JSON body — so the write is bound to `{ id, classroom_id }` and only counts
  // when it matched exactly one row. Same shape as the page and quiz writes on
  // this branch. An empty string clears the grade, which is how the table's
  // editable cell sends a cleared value.
  const updated = await ClassmojiService.classroomMembership.updateInClassroom(
    membershipId,
    classroom.id,
    { letter_grade: rawLetterGrade ? rawLetterGrade : null }
  );

  if (!updated) {
    return { error: 'Student not found.' };
  }

  // Audited only once the write has landed, so a row naming this classroom
  // always describes a change that happened in it — same rule the quiz and page
  // mutations follow. The loader logs a VIEW; this is the surface's only write,
  // and it now has a second role that can reach it.
  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership!.role,
    action: 'UPDATE',
    resourceType: 'GRADES',
    resourceId: membershipId,
    metadata: {
      tool: 'web:grades.update_letter_grade',
      letter_grade: rawLetterGrade ? rawLetterGrade : null,
    },
  });

  return {
    success: true,
  };
};

/**
 * Release (or hide) every student's final grade at once: the gradebook's
 * Letter column, letter overrides included, which students otherwise never
 * see. OWNER only: the gradebook admits teachers, so this intent carries its
 * own owner gate (a refused attempt is audited by the gate).
 */
const setFinalGradesReleased = async (request: Request, classSlug: string, released: unknown) => {
  const { userId, classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'GRADES',
    action: 'release_final_grades',
  });
  if (typeof released !== 'boolean') {
    return { error: 'Invalid request.' };
  }

  await ClassmojiService.classroom.updateSettings(classroom.id, {
    final_grades_released: released,
  });

  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership!.role,
    action: 'UPDATE',
    resourceType: 'GRADES',
    resourceId: classroom.id,
    metadata: {
      tool: released ? 'web:grades.release_final_grades' : 'web:grades.hide_final_grades',
      final_grades_released: released,
    },
  });

  return { success: true, final_grades_released: released };
};

export default Grades;
