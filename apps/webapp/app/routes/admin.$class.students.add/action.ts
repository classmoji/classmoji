import { ClassmojiService } from '@classmoji/services';
import { signInviteToken } from '@classmoji/auth/invite-token';
import Tasks from '@classmoji/tasks';
import { tasks } from '@trigger.dev/sdk';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { addClassroomAuditLog } from '~/utils/helpers';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, userId, membership } = await requireClassroomAdmin(request, classSlug, {
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

  // Audit before the emails, as the MCP tool does: the rows are committed, so
  // a failing email send must not leave the change unrecorded.
  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership!.role,
    action: 'CREATE',
    resourceType: 'STUDENT_ROSTER',
    metadata: {
      tool: 'web:students.add',
      added: result.addedExistingUsers,
      invited: result.invitedNewUsers,
      already_enrolled: result.alreadyEnrolled.length,
    },
    // Two batches added a few seconds apart are two roster changes.
    dedupe: false,
  });

  if (result.emails.length > 0) {
    await Tasks.sendBatchEmailTask.trigger({ emails: result.emails.map(e => e.payload) });
  }
  // Gitlab students who already have Gitlab: create their projects now.
  for (const activation of result.activations) {
    await tasks.trigger('activate_membership', activation);
  }

  const added = result.addedExistingUsers + result.invitedNewUsers;
  const already = result.alreadyEnrolled.length;
  const messages: string[] = [];
  if (added > 0 || already === 0) {
    messages.push(`${added} student${added !== 1 ? 's' : ''} invited to the class.`);
  }
  if (already > 0) messages.push(`${already} already in the class.`);

  return {
    action: 'ADD_STUDENTS',
    success: messages.join(' '),
  };
};
