import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService, StaffServiceError } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/** The roles this screen may grant. STUDENT is the roster's business. */
const STAFF_ROLES = ['ASSISTANT', 'TEACHER', 'OWNER'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

const ROLE_NOUN: Record<StaffRole, string> = {
  ASSISTANT: 'an assistant',
  TEACHER: 'a teacher',
  OWNER: 'a co-owner',
};

/**
 * The role is client input, so it is checked here rather than trusted. The
 * service asserts it again (`invalid_role`) — this only buys a message that
 * names the problem.
 */
const parseRole = (value: unknown): StaffRole | null =>
  typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value)
    ? (value as StaffRole)
    : null;

/**
 * Turn a StaffServiceError into the sentence the instructor needs.
 *
 * Each of these is a different thing to go and fix, so collapsing them into one
 * "Failed to…" (which is what this route used to do) hid the only useful part of
 * the failure. Anything that is not a StaffServiceError is a bug or an outage,
 * not a caller mistake, and keeps the generic fallback.
 */
const staffErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof StaffServiceError)) return fallback;

  switch (error.code) {
    case 'git_user_not_found':
      return 'No GitHub user with that username. Check the spelling and try again.';
    case 'staff_not_found':
      return 'That person no longer holds that role in this class — reload the page.';
    case 'no_org_configured':
      return 'This classroom has no linked GitHub organization, so staff cannot be managed yet.';
    case 'login_conflict':
      return 'That username belongs to a different account than the one already on file for it — contact support.';
    case 'last_owner':
      return 'This is the only owner of the classroom. Add another owner before removing this one.';
    case 'grader_flag_invalid':
      return 'The grader flag applies to assistants and teachers only — owners do not join the grading pool.';
    case 'invalid_role':
      return 'That is not a teaching-staff role.';
    default:
      return fallback;
  }
};

/**
 * Mutations for the Teaching Staff screen — OWNER only, and this gate is this
 * action's OWN.
 *
 * React Router runs the matched LEAF action first; a parent layout loader only
 * runs afterwards, for revalidation. So nothing about sitting under /admin gates
 * anything here. The route's LOADER reads at the teaching-team tier (an
 * assistant may see who is on the team); these writes are deliberately narrower
 * and must stay that way. Granting OWNER in particular is an owner-only act:
 * this gate is the only thing standing behind the client's confirmation dialog.
 */
export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEACHING_STAFF',
    action: 'manage_staff',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async createStaff() {
      const role = parseRole(data.role);
      if (!role) {
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Pick a role for this staff member.',
        };
      }

      try {
        // The GitHub profile is resolved server-side by the service from the
        // login alone, so the client cannot choose the provider_id the account
        // is keyed to. `classroom.id` is the classroom requireClassroomAdmin
        // authorized, not a fresh lookup on the same slug.
        //
        // Roles are ADDITIVE: granting one to somebody who already holds a
        // different role here adds a membership rather than replacing theirs.
        const result = await ClassmojiService.staff.addStaff({
          classroomId: classroom.id,
          login: data.login,
          role,
          name: data.name,
          email: data.email,
        });

        if (result.alreadyExists) {
          return {
            action: ActionTypes.SAVE_USER,
            error: `${result.login} is already ${ROLE_NOUN[role]} in this class.`,
          };
        }

        return {
          success: `Added ${result.login} as ${ROLE_NOUN[role]}`,
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        console.error('createStaff failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: staffErrorMessage(error, 'Failed to add staff member. Please try again.'),
        };
      }
    },

    async updateStaff() {
      const role = parseRole(data.role);
      if (!role) {
        return { action: ActionTypes.SAVE_USER, error: 'That is not a teaching-staff role.' };
      }

      try {
        // The role travels with the login: memberships are unique on
        // (classroom, user, role), so a user who holds two roles here has two
        // rows and the flag belongs to exactly one of them.
        await ClassmojiService.staff.updateStaff({
          classroomId: classroom.id,
          login: data.login,
          role,
          isGrader: data.isGrader,
        });
        return {
          success: 'Staff member updated',
          action: ActionTypes.SAVE_USER,
        };
      } catch (error: unknown) {
        // Same shape as the sibling branches: a service failure becomes a
        // callout, not a trip through the route error boundary.
        console.error('updateStaff failed:', error);
        return {
          action: ActionTypes.SAVE_USER,
          error: staffErrorMessage(error, 'Failed to update staff member.'),
        };
      }
    },

    async removeStaff() {
      const role = parseRole(data.role);
      if (!role) {
        return { action: ActionTypes.REMOVE_USER, error: 'That is not a teaching-staff role.' };
      }

      try {
        // The service resolves the target from the DB by (classroom, login,
        // role) and builds the task payload entirely server-side; the route
        // keeps awaiting the run so the UI can report the finished removal. It
        // also refuses to remove the LAST owner before triggering anything,
        // which is why that failure arrives here rather than inside the task.
        const { runId } = await ClassmojiService.staff.removeStaff({
          classroomId: classroom.id,
          login: data.login,
          role,
        });

        await waitForRunCompletion(runId);

        return {
          success: 'Staff member removed',
          action: ActionTypes.REMOVE_USER,
        };
      } catch (error: unknown) {
        console.error('removeStaff failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: staffErrorMessage(error, 'Failed to remove staff member. Please try again.'),
        };
      }
    },
  });
};
