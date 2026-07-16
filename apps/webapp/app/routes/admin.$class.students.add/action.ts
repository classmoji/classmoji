import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const {
    classroom,
    userId: _userId,
    membership,
  } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'bulk_add_students',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = (await request.json()) as { students: Array<{ email: string; name?: string }> };

  // Shared with the MCP roster_add_student tool: the DB split + email
  // composition live in the service; the route triggers the returned emails.
  const result = await ClassmojiService.roster.addStudents({
    classroomId: classroom.id,
    students: data.students,
  });

  if (result.emails.length > 0) {
    await Tasks.sendEmailTask.batchTrigger(result.emails);
  }

  return {
    action: 'ADD_STUDENTS',
    success: `${data.students.length} student${data.students.length !== 1 ? 's' : ''} invited to the class.`,
  };
};
