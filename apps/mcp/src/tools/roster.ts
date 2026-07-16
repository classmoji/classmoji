/**
 * Roster tools — roster_add_student / roster_remove_student (plan §5.2 gap 5).
 *
 * Tier: OWNER only (requireClassroomAdmin → ['OWNER'] on both web routes,
 * admin.$class.students add/remove).
 *
 * ADD mirrors admin.$class.students.add: the DB split + email composition are
 * shared via ClassmojiService.roster.addStudents (extracted so route + tool
 * take one path); this tool triggers the returned emails. It sends REAL emails
 * and is NOT idempotent (calling twice emails twice — the DB writes are
 * skipDuplicates, the emails are not). It does NOT touch GitHub — activation
 * stays student-driven.
 *
 * REMOVE triggers the single-source-of-truth remove_user_from_organization
 * task (never reimplemented). Unlike the web action — which forwards a
 * client-supplied `data.user` straight into the task (an S1 hole) — this tool
 * resolves the target from the DB by (classroom, login/user_id) and builds the
 * task payload ENTIRELY server-side. It is destructive and requires confirm:
 * true, because when the student belongs to no other class in the GitHub org
 * the task removes them from the org (revoking access and deleting their
 * private forks). Fire-and-forget: a dropped job leaves the student in place
 * (fails safe) and there is no wait-timeout window for a retry to re-fire.
 */

import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';
import { tasks } from '@trigger.dev/sdk';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

interface RosterAddStudentArgs {
  classroom: string;
  students: Array<{ email: string; name?: string }>;
}

export const rosterAddStudentTool: ToolDefinition<RosterAddStudentArgs> = {
  name: 'roster_add_student',
  // Sends real invitation emails (openWorld). Adds rows only — nothing removed.
  annotations: { destructive: false, openWorld: true },
  title: 'Add students to the roster',
  description:
    'Adds students to the classroom roster by email (bulk). Owner only. Existing Classmoji users ' +
    'are enrolled immediately (still pending their GitHub org invite); unknown emails get an ' +
    'invitation row. Sends a real email to every student — NOT idempotent, calling twice emails ' +
    'twice. Does not touch GitHub or create repos; students get their org invite + repos when ' +
    'they first sign in and join.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    students: z
      .array(
        z.object({
          email: z.string().email().describe('Student email'),
          name: z.string().min(1).max(200).optional().describe('Student name'),
        })
      )
      .min(1)
      .max(200)
      .describe('Students to add (1–200)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // classroomId is ALWAYS the authorized classroom, never request input.
    const result = await ClassmojiService.roster.addStudents({
      classroomId: classroom.classroomId,
      students: args.students,
    });

    // Audit BEFORE sending emails: addStudents has already committed the
    // memberships/invites, so a transient email-service failure must not leave
    // that mutation un-audited (plan §5.1 — every mutation writes an audit row).
    await writeAudit(ctx, {
      resource_type: 'STUDENT_ROSTER',
      action: 'CREATE',
      data: {
        tool: 'roster_add_student',
        added: result.addedExistingUsers,
        invited: result.invitedNewUsers,
      },
    });

    if (result.emails.length > 0) {
      await Tasks.sendEmailTask.batchTrigger(result.emails);
    }

    return ok({
      success: true,
      added: result.addedExistingUsers,
      invited: result.invitedNewUsers,
      total: args.students.length,
    });
  },
};

interface RosterRemoveStudentArgs {
  classroom: string;
  student_login?: string;
  user_id?: string;
  confirm: true;
}

export const rosterRemoveStudentTool: ToolDefinition<RosterRemoveStudentArgs> = {
  name: 'roster_remove_student',
  // Can remove the student from the GitHub org (deleting their private forks) →
  // destructive + openWorld. Requires confirm:true (enforced by the schema).
  annotations: { destructive: true, openWorld: true },
  title: 'Remove a student from the classroom',
  description:
    'Removes a student from the classroom. Owner only, destructive, requires confirm:true. ' +
    'Identify the student by student_login or user_id. Triggers the standard removal workflow: ' +
    'it removes them from the classroom GitHub team and, IF they are in no other class in that ' +
    'GitHub org, removes them from the org entirely (revoking access and DELETING their private ' +
    'forks) — this is not cleanly reversible. Deletes the classroom membership. Runs in the ' +
    'background; does not delete their assignment repos, but org removal revokes access.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    student_login: z.string().min(1).optional().describe('The student GitHub login'),
    user_id: z.string().uuid().optional().describe('The student user id (alternative to login)'),
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges this can remove the student from the GitHub org'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Resolve the target user id server-side (login → user, or a supplied id).
    let userId = args.user_id;
    if (!userId) {
      if (!args.student_login) {
        throw new ToolError('invalid_params', 'Provide student_login or user_id');
      }
      const user = await ClassmojiService.user.findByLogin(args.student_login);
      if (!user) throw scopedNotFound('Student');
      userId = user.id;
    }

    // S1: the target must be a STUDENT in THIS classroom. Missing and
    // cross-classroom both return the same not_found (no existence leak).
    const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.classroomId,
      userId,
      'STUDENT'
    );
    if (!membership?.user) throw scopedNotFound('Student');
    const target = membership.user;
    // has_accepted_invite is a MEMBERSHIP field (the web UI merges it onto its
    // client-side user object); the removal task reads it as user.has_accepted_invite.
    const hasAcceptedInvite = membership.has_accepted_invite;

    // Classroom-with-git-organization for the task payload (legacy shape the
    // web route uses: task derives gitOrg from organization.git_organization).
    const classroomRecord = await ClassmojiService.classroom.findById(classroom.classroomId);
    if (!classroomRecord) throw new ToolError('internal', 'Classroom record unavailable');

    // Audit the intent BEFORE firing the async removal.
    await writeAudit(ctx, {
      resource_type: 'STUDENT_ROSTER',
      resource_id: target.id,
      action: 'DELETE',
      data: {
        tool: 'roster_remove_student',
        user_id: target.id,
        login: target.login,
        had_accepted_invite: hasAcceptedInvite,
      },
    });

    // Trigger the single-source-of-truth removal task with a payload built
    // ENTIRELY from resolved DB records — never from client input. Fire-and-
    // forget: a dropped job fails safe (student stays), and there is no wait
    // window for a client retry to re-fire a destructive GitHub op.
    void tasks
      .trigger('remove_user_from_organization', {
        payload: {
          user: {
            id: target.id,
            login: target.login,
            has_accepted_invite: hasAcceptedInvite,
          },
          organization: classroomRecord,
          role: 'STUDENT',
        },
      })
      .catch((error: unknown) => {
        console.error('[mcp] remove_user_from_organization trigger failed:', error);
      });

    return ok({
      success: true,
      queued: true,
      user_id: target.id,
      login: target.login,
      message:
        'Student removal queued — removing GitHub team/org access and the membership in the background.',
    });
  },
};
