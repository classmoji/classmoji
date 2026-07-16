import getPrisma from '@classmoji/database';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as classroomInviteService from './classroomInvite.service.ts';

export interface RosterStudentInput {
  email: string;
  name?: string;
}

export interface RosterEmail {
  payload: { to: string; subject: string; html: string };
}

export interface AddStudentsResult {
  addedExistingUsers: number;
  invitedNewUsers: number;
  /**
   * Composed notification emails for the CALLER to send. Services must not
   * import @classmoji/tasks (tasks already depends on services — importing it
   * here would be circular), so email composition lives here but the trigger
   * stays with the caller (web route / MCP tool).
   */
  emails: RosterEmail[];
}

/**
 * Add students to a classroom roster by email (bulk). Existing platform users
 * are enrolled directly (a STUDENT membership with has_accepted_invite=false,
 * pending their GitHub org invite); unknown emails get a ClassroomInvite row.
 * Shared by the web "Add Students" action and the MCP roster_add_student tool
 * so both take one code path.
 *
 * Does NOT touch GitHub or provision repos — activation stays student-driven
 * (self-join / member_added webhook → activate_membership).
 */
export const addStudents = async ({
  classroomId,
  students,
}: {
  classroomId: string;
  students: RosterStudentInput[];
}): Promise<AddStudentsResult> => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new Error(`[roster] classroom ${classroomId} not found`);
  }

  const emails = students.map(s => s.email.toLowerCase());
  const existingUsers = await getPrisma().user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, name: true },
  });
  const existingByEmail = new Map(existingUsers.map(u => [(u.email ?? '').toLowerCase(), u]));

  const toAddDirectly: Array<RosterStudentInput & { userId: string; userName: string | null }> = [];
  const toInvite: RosterStudentInput[] = [];
  for (const student of students) {
    const existing = existingByEmail.get(student.email.toLowerCase());
    if (existing) {
      toAddDirectly.push({ ...student, userId: existing.id, userName: existing.name });
    } else {
      toInvite.push(student);
    }
  }

  const emailsOut: RosterEmail[] = [];

  // Enroll existing users directly (they still need to accept the GitHub org invite).
  if (toAddDirectly.length > 0) {
    const memberships = toAddDirectly.map(student => ({
      classroom_id: classroomId,
      user_id: student.userId,
      role: 'STUDENT' as const,
      has_accepted_invite: false,
    }));
    await classroomMembershipService.createMany(memberships);

    for (const student of toAddDirectly) {
      emailsOut.push({
        payload: {
          to: student.email,
          subject: `[Classmoji] You've been added to ${classroom.name}`,
          html: `<p>Hi ${student.userName || student.name}!</p>
          <p>You have been added to <b>${classroom.name}</b> on Classmoji.</p>
          <p>Click the following link to access your classroom: <a href="${process.env.WEBAPP_URL}">${process.env.WEBAPP_URL}</a></p>`,
        },
      });
    }
  }

  // Invite unknown emails (claimed when they register).
  if (toInvite.length > 0) {
    const invites = toInvite.map(student => ({
      school_email: student.email,
      classroom_id: classroomId,
      student_name: student.name,
    }));
    await classroomInviteService.createManyInvites(invites);

    for (const student of toInvite) {
      emailsOut.push({
        payload: {
          to: student.email,
          subject: `[Classmoji] You're invited to join ${classroom.name}`,
          html: `<p>Hi ${student.name}!</p>
          <p>You have been invited to join <b>${classroom.name}</b> on Classmoji.</p>
          <p>Click the following link to login: <a href="${process.env.WEBAPP_URL}">${process.env.WEBAPP_URL}</a></p>`,
        },
      });
    }
  }

  return {
    addedExistingUsers: toAddDirectly.length,
    invitedNewUsers: toInvite.length,
    emails: emailsOut,
  };
};
