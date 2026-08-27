import { Await, Outlet } from 'react-router';
import { Suspense } from 'react';
import { Skeleton } from 'antd';

import GradesTable from './GradesTable';
import { ClassmojiService } from '@classmoji/services';
import { addAuditLog } from '~/utils/helpers';
import { requireClassroomStaff, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  // OWNER and TEACHER. Letter grades and comments are a teaching-staff surface
  // rather than an owner-only one, and this route is served under both the
  // /admin and /teacher prefixes.
  const { classroom } = await requireClassroomStaff(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'view_grades',
  });

  const promises = {
    emojiMappings: ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    repositories: ClassmojiService.repository.findByClassroomSlug(classSlug!),
    students: ClassmojiService.user.findRepositoriesPerStudent(classroom),
    // Everything returned here is serialised to the browser, and the table
    // reads exactly one field out of the settings row — the late penalty used
    // by calculateStudentFinalGrade. Project it down to that field rather than
    // handing the whole server-side row to the client.
    settings: ClassmojiService.classroom
      .getClassroomSettingsForServer(classroom.id)
      .then(settings => ({
        late_penalty_points_per_hour: settings?.late_penalty_points_per_hour ?? 0,
      })),
    letterGradeMappings: ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id),
    memberships: ClassmojiService.classroomMembership.findByClassroomId(classroom.id),
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
            <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">
              Grades
            </h1>
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
              students={resolvedStudents as unknown as Parameters<typeof GradesTable>[0]['students']}
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
  const { classroom, membership } = await requireClassroomStaff(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'update_grades',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const { membership_id, letter_grade } = data;

  await ClassmojiService.classroomMembership.updateById(membership_id, {
    letter_grade: letter_grade ? letter_grade : null,
  });

  return {
    success: true,
  };
};

export default Grades;
