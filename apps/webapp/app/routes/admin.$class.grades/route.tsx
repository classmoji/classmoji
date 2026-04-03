import { Await, Outlet } from 'react-router';
import { Suspense } from 'react';
import { Skeleton } from 'antd';

import GradesTable from './GradesTable';
import { ClassmojiService } from '@classmoji/services';
import { PageHeader } from '~/components';
import { addAuditLog } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'view_grades',
  });

  const promises = {
    emojiMappings: ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    modules: ClassmojiService.module.findByClassroomSlug(classSlug!),
    students: ClassmojiService.user.findRepositoriesPerStudent(classroom),
    settings: ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id),
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
          <div>
            <PageHeader title="Grades" routeName="grades" />
            <Skeleton active />
          </div>
        }
      >
        <Await resolve={allData}>
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
              modules={resolvedModules as Parameters<typeof GradesTable>[0]['modules']}
              students={resolvedStudents as Parameters<typeof GradesTable>[0]['students']}
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

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'GRADES',
    action: 'update_grades',
  });

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
