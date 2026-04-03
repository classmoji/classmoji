import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';
import getPrisma from '@classmoji/database';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'bulk_add_students',
  });

  const data = (await request.json()) as { students: Array<{ email: string; name?: string }> };
  const emails = data.students.map(s => s.email.toLowerCase());

  // Find users who already exist on the platform
  const existingUsers = await getPrisma().user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, name: true },
  });
  const existingEmailSet = new Set(existingUsers.map(u => u!.email!.toLowerCase()));

  // Split students into existing users vs new invites
  const studentsToInvite = [];
  const studentsToAddDirectly = [];

  for (const student of data.students) {
    const emailLower = student.email.toLowerCase();
    if (existingEmailSet.has(emailLower)) {
      const user = existingUsers.find(u => u!.email!.toLowerCase() === emailLower);
      studentsToAddDirectly.push({ ...student, userId: user!.id, userName: user!.name });
    } else {
      studentsToInvite.push(student);
    }
  }

  // Create classroom memberships for existing users
  if (studentsToAddDirectly.length > 0) {
    const memberships = studentsToAddDirectly.map(student => ({
      classroom_id: classroom.id,
      user_id: student.userId,
      role: 'STUDENT' as const,
      has_accepted_invite: false, // They still need to accept GitHub org invite
    }));

    await ClassmojiService.classroomMembership.createMany(memberships);

    // Send notification emails to existing users
    const existingUserEmails = studentsToAddDirectly.map(student => ({
      payload: {
        to: student.email,
        subject: `[Classmoji] You've been added to ${classroom.name}`,
        html: `<p>Hi ${student.userName || student.name}!</p>
          <p>You have been added to <b>${classroom.name}</b> on Classmoji.</p>
          <p>Click the following link to access your classroom: <a href="${process.env.WEBAPP_URL}">${process.env.WEBAPP_URL}</a></p>`,
      },
    }));

    await Tasks.sendEmailTask.batchTrigger(existingUserEmails);
  }

  // Create invites for new users
  if (studentsToInvite.length > 0) {
    const invites = studentsToInvite.map(student => ({
      school_email: student.email,
      classroom_id: classroom.id,
      student_name: student.name,
    }));

    await ClassmojiService.classroomInvite.createManyInvites(invites);

    // Send email invitations to new students
    const newUserEmails = studentsToInvite.map(student => ({
      payload: {
        to: student.email,
        subject: `[Classmoji] You're invited to join ${classroom.name}`,
        html: `<p>Hi ${student.name}!</p>
          <p>You have been invited to join <b>${classroom.name}</b> on Classmoji.</p>
          <p>Click the following link to login: <a href="${process.env.WEBAPP_URL}">${process.env.WEBAPP_URL}</a></p>`,
      },
    }));

    await Tasks.sendEmailTask.batchTrigger(newUserEmails);
  }

  return {
    action: 'ADD_STUDENTS',
    success: `${data.students.length} student${data.students.length !== 1 ? 's' : ''} invited to the class.`,
  };
};
