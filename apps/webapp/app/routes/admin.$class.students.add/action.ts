import { ClassmojiService } from '@classmoji/services';
import { signInviteToken } from '@classmoji/auth/invite-token';
import Tasks from '@classmoji/tasks';
import { tasks } from '@trigger.dev/sdk';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { auditActor } from '~/utils/auditActor.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const gate = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'bulk_add_students',
  });
  const { classroom, membership } = gate;
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = (await request.json()) as { students: Array<{ email: string; name?: string }> };

  // Shared with the MCP roster_add_student tool: the DB split + email
  // composition live in the service; the route triggers the returned emails.
  const result = await ClassmojiService.roster.addStudents({
    signInvite: email => signInviteToken({ email, classroomId: classroom.id }),
    classroomId: classroom.id,
    students: data.students,
    // The service records the add for this owner once the rows are
    // committed, before the emails below, as for the MCP tool.
    actor: await auditActor(request, gate, 'web:students.add'),
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
  // The form skips these before submitting; this is the server refusing one
  // that got past it.
  if (result.invalid.length > 0) {
    messages.push(
      `Skipped ${result.invalid.length} invalid email${result.invalid.length !== 1 ? 's' : ''}: ${result.invalid.join(', ')}`
    );
  }

  return {
    action: 'ADD_STUDENTS',
    success: messages.join(' '),
  };
};
