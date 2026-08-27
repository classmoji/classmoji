import { Await, Outlet } from 'react-router';
import { Suspense } from 'react';
import { Skeleton } from 'antd';

import GradesTable from './GradesTable';
import { ClassmojiService } from '@classmoji/services';
import { addAuditLog, addClassroomAuditLog } from '~/utils/helpers';
import { pickOwnerOnlyContactFields } from '~/utils/studentFields.server';
import { requireClassroomStaff, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  // OWNER and TEACHER. Letter grades and comments are a teaching-staff surface
  // rather than an owner-only one, and this route is served under both the
  // /admin and /teacher prefixes.
  const { classroom, membership } = await requireClassroomStaff(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'view_grades',
  });

  // `membership.role` is the caller's HIGHEST role in this classroom, resolved
  // in privilege order — an owner who also holds another role here still
  // resolves as OWNER. Same split the roster route applies, and the contact
  // trio is shared with it so the two cannot drift.
  const isRealOwner = membership?.role === 'OWNER';

  const promises = {
    emojiMappings: ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    repositories: ClassmojiService.repository.findByClassroomSlug(classSlug!),
    // Everything below is serialised to the browser, so each source is
    // projected down to the fields the table renders. The services return whole
    // `User` and `ClassroomMembership` rows — which carry contact details, the
    // global better-auth role, ban state and the Stripe customer id — and none
    // of that belongs in a page.
    students: ClassmojiService.user.findRepositoriesPerStudent(classroom).then(students =>
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
          comment: m.comment,
          letter_grade: m.letter_grade,
        }))
      ),
  };

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'CLASS_GRADES_SCREEN',
  });

  return {
    allData: Promise.all(Object.values(promises)),
  };
};

const Grades = ({ loaderData }: Route.ComponentProps) => {
  const { allData } = loaderData;

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
          ]) => (
            <GradesTable
              emojiMappings={
                resolvedEmojiMappings as Parameters<typeof GradesTable>[0]['emojiMappings']
              }
              repositories={resolvedModules as Parameters<typeof GradesTable>[0]['repositories']}
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

export default Grades;
