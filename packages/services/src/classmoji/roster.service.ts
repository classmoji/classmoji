import getPrisma from '@classmoji/database';
import { parseGitlabId } from '@classmoji/utils';
import { appUrl, escapeVars, inviteLandingUrl } from '../emails/escape.ts';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as classroomInviteService from './classroomInvite.service.ts';

export interface RosterStudentInput {
  email: string;
  name?: string;
}

export interface RosterEmail {
  payload: {
    to: string;
    template: {
      id: 'roster-added' | 'roster-invited';
      variables: Record<string, string | number>;
    };
  };
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
  /**
   * Gitlab: students enrolled already active (they have a Gitlab account on
   * the classroom's instance), whose projects the CALLER should now create by
   * triggering `activate_membership` with each entry.
   */
  activations: Array<{ login: string; gitOrganizationId: string }>;
}

/**
 * Add students to a classroom roster by email (bulk). Existing platform users
 * are enrolled directly (a STUDENT membership with has_accepted_invite=false,
 * pending their GitHub org invite; on Gitlab, active right away when they
 * already have Gitlab, see `activations`); unknown emails get a ClassroomInvite row.
 * Shared by the web "Add Students" action and the MCP roster_add_student tool
 * so both take one code path.
 *
 * Does NOT touch GitHub or provision repos — activation stays student-driven
 * (self-join / member_added webhook → activate_membership).
 */
export const addStudents = async ({
  classroomId,
  students,
  signInvite,
}: {
  classroomId: string;
  students: RosterStudentInput[];
  /**
   * Mints the signed token the invite link carries for an address. Injected
   * because signing lives in @classmoji/auth, which depends on this package.
   */
  signInvite: (email: string) => string;
}): Promise<AddStudentsResult> => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new Error(`[roster] classroom ${classroomId} not found`);
  }

  const emails = students.map(s => s.email.toLowerCase());
  const existingUsers = await getPrisma().user.findMany({
    // Only a verified address identifies a person; an unverified one gets an
    // invite like any unknown address, claimed once they verify it.
    where: { email: { in: emails }, emailVerified: true },
    select: { id: true, email: true, name: true },
  });

  // Gitlab has no org invite to accept: a student who already has a Gitlab
  // account on this classroom's instance is enrolled active, and their
  // projects are created now. Anyone else activates on their first Gitlab
  // sign-in (select-organization).
  const org = classroom.git_organization;
  // Users with a Gitlab account on this classroom's instance, by id → their
  // Gitlab username (what activation looks them up by).
  const readyOnGitLab = new Map<string, string>();
  if (org?.provider === 'GITLAB' && existingUsers.length > 0) {
    const instanceId = org.gitlab_instance_id ?? null;
    const accounts = await getPrisma().account.findMany({
      where: { user_id: { in: existingUsers.map(u => u.id) }, provider_id: 'gitlab' },
      select: { user_id: true, account_id: true, username: true },
    });
    for (const account of accounts) {
      if (account.username && parseGitlabId(account.account_id).instanceId === instanceId) {
        readyOnGitLab.set(account.user_id, account.username);
      }
    }
  }
  const existingByEmail = new Map(existingUsers.map(u => [(u.email ?? '').toLowerCase(), u]));

  const toAddDirectly: Array<RosterStudentInput & { userId: string; userName: string | null }> = [];
  const toInvite: RosterStudentInput[] = [];
  for (const student of students) {
    const existing = existingByEmail.get(student.email.toLowerCase());
    if (existing) {
      toAddDirectly.push({
        ...student,
        userId: existing.id,
        userName: existing.name,
      });
    } else {
      toInvite.push(student);
    }
  }

  const emailsOut: RosterEmail[] = [];
  const activations: AddStudentsResult['activations'] = [];

  // Enroll existing users directly. On Github they still need to accept the
  // org invite; on Gitlab they are active if they already have Gitlab.
  if (toAddDirectly.length > 0) {
    const memberships = toAddDirectly.map(student => ({
      classroom_id: classroomId,
      user_id: student.userId,
      role: 'STUDENT' as const,
      has_accepted_invite: readyOnGitLab.has(student.userId),
    }));
    await classroomMembershipService.createMany(memberships);
    if (org) {
      for (const student of toAddDirectly) {
        const gitlabUsername = readyOnGitLab.get(student.userId);
        if (gitlabUsername) {
          activations.push({ login: gitlabUsername, gitOrganizationId: org.id });
        }
      }
    }

    for (const student of toAddDirectly) {
      emailsOut.push({
        payload: {
          to: student.email,
          template: {
            id: 'roster-added',
            // Names and classroom titles are user-authored, and Resend injects
            // variables raw, so escape before they reach the template.
            variables: escapeVars({
              STUDENT_NAME: student.userName || student.name || 'there',
              CLASSROOM_NAME: classroom.name,
              APP_URL: appUrl(),
            }),
          },
        },
      });
    }
  }

  // Invite unknown emails (claimed when they register).
  if (toInvite.length > 0) {
    const invites = toInvite.map(student => ({
      school_email: student.email,
      classroom_id: classroomId,
      // `name` is optional for the MCP caller but the column is NOT NULL.
      student_name: student.name ?? '',
    }));
    await classroomInviteService.createManyInvites(invites);

    for (const student of toInvite) {
      emailsOut.push({
        payload: {
          to: student.email,
          template: {
            id: 'roster-invited',
            // `student.name` is optional and teacher-typed: it previously
            // rendered "Hi undefined!" when omitted, and was never escaped.
            variables: escapeVars({
              STUDENT_NAME: student.name || 'there',
              CLASSROOM_NAME: classroom.name,
              PROVIDER_LABEL:
                classroom.git_organization?.provider === 'GITLAB' ? 'Gitlab' : 'Github',
              // Carries a signed token for the invited address, which sign-up
              // accepts as proof of it: the link used to be the same for
              // everyone, and students retyping a different address at
              // registration never got their invite.
              APP_URL: inviteLandingUrl(signInvite(student.email)),
            }),
          },
        },
      });
    }
  }

  return {
    addedExistingUsers: toAddDirectly.length,
    invitedNewUsers: toInvite.length,
    emails: emailsOut,
    activations,
  };
};
