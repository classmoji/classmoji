import { ClassmojiService } from '@classmoji/services';
import { signInviteToken } from '@classmoji/auth/invite-token';
import Tasks from '@classmoji/tasks';
import { tasks } from '@trigger.dev/sdk';
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
    signInvite: email => signInviteToken({ email, classroomId: classroom.id }),
    classroomId: classroom.id,
    students: data.students,
  });

  if (result.emails.length > 0) {
    await Tasks.sendBatchEmailTask.trigger({ emails: result.emails.map(e => e.payload) });
  }
  // Gitlab students who already have Gitlab: create their projects now.
  for (const activation of result.activations) {
    await tasks.trigger('activate_membership', activation);
  }

  return {
    action: 'ADD_STUDENTS',
    success: `${data.students.length} student${data.students.length !== 1 ? 's' : ''} invited to the class.`,
  };
};
