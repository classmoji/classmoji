import { namedAction } from 'remix-utils/named-action';

import {
  ClassmojiService,
  HelperService,
  StaffServiceError,
  type StaffRemovalStart,
  type UngradedChoice,
  type UngradedSlotsOutcome,
} from '@classmoji/services';
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
 * The login is client input in exactly the way the role is, so it gets the same
 * treatment: checked here, where the answer is an inline message, rather than
 * left to throw somewhere downstream and surface as a 500 through the route
 * error boundary.
 *
 * SHAPE ONLY. Login rules differ by provider (GitHub allows alphanumerics and
 * dashes; GitLab also dots and underscores), so this asks for a plausible
 * single token and leaves the identity question to the provider lookup, which
 * answers it properly with git_user_not_found.
 */
const parseLogin = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const login = value.replace('@', '').trim();
  return login.length > 0 && login.length <= 100 && !/\s/.test(login) ? login : null;
};

/** The grader flag reaches a Prisma boolean column — anything else is a 500. */
const parseGraderFlag = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

/**
 * The instructor's optional overrides. Absent and empty both mean "use the git
 * profile", which is what the service does with a null; anything that is not a
 * string is not an override at all.
 */
const parseOverride = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** What happens to a removed grader's ungraded submissions (see HelperService.startStaffRemoval). */
const UNGRADED_CHOICES = [
  'reassign',
  'unassign',
  'keep',
] as const satisfies readonly UngradedChoice[];

/**
 * null → no choice sent (keep, the old behaviour); undefined → a value that is
 * not one of the three, refused rather than guessed at.
 */
const parseUngradedChoice = (value: unknown): UngradedChoice | null | undefined => {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && (UNGRADED_CHOICES as readonly string[]).includes(value)
    ? (value as UngradedChoice)
    : undefined;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The success callout: the removal, then what became of the ungraded slots. */
const removalMessage = (ungraded: UngradedSlotsOutcome | null): string => {
  if (!ungraded) return 'Staff member removed';

  const parts = ['Staff member removed.'];
  const subs = (n: number) => plural(n, 'ungraded submission', 'ungraded submissions');

  if (ungraded.choice === 'keep') {
    parts.push(`${subs(ungraded.kept)} still assigned to them.`);
  } else {
    const moved = ungraded.reassigned.reduce((sum, r) => sum + r.count, 0);
    if (moved > 0) {
      const who = ungraded.reassigned.map(r => `${r.login} ${r.count}`).join(', ');
      parts.push(
        ungraded.queued
          ? `${subs(moved)} being reassigned in the background (${who}).`
          : `${subs(moved)} reassigned (${who}).`
      );
    }
    if (ungraded.fallback === 'no_eligible_graders') {
      parts.push('No other graders are available, so their submissions were unassigned instead.');
    }
    const dropped = ungraded.unassigned + ungraded.alreadyCovered;
    if (dropped > 0) {
      parts.push(
        `${subs(dropped)} ${ungraded.queued ? 'being unassigned in the background' : 'unassigned'}.`
      );
    }
    if (ungraded.unassignedIneligible > 0) {
      parts.push(
        `${plural(ungraded.unassignedIneligible, 'was', 'were')} unassigned because the grader picked for them is no longer a grader.`
      );
    }
  }
  if (ungraded.failed > 0) {
    parts.push(
      `${plural(ungraded.failed, 'submission', 'submissions')} could not be changed and still list them as grader.`
    );
  }
  return parts.join(' ');
};

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

  // namedAction picks the branch from the query string, so the branch is known
  // even when the body is not readable — which is what decides the ActionTypes
  // below. Getting that wrong would leave the progress callout the client
  // opened spinning until the page unmounted, since the two are matched by it.
  const isRemoval = new URL(request.url).search.startsWith('?/removeStaff');

  let data: Record<string, unknown>;
  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('body is not an object');
    }
    data = body as Record<string, unknown>;
  } catch {
    return {
      action: isRemoval ? ActionTypes.REMOVE_USER : ActionTypes.SAVE_USER,
      error: 'Could not read that request. Reload the page and try again.',
    };
  }

  return namedAction(request, {
    async createStaff() {
      const role = parseRole(data.role);
      if (!role) {
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Pick a role for this staff member.',
        };
      }

      const login = parseLogin(data.login);
      if (!login) {
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Enter the GitHub username of the person to add.',
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
          login,
          role,
          name: parseOverride(data.name),
          email: parseOverride(data.email),
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

      const login = parseLogin(data.login);
      if (!login) {
        return {
          action: ActionTypes.SAVE_USER,
          error: 'Could not tell which staff member that was — reload the page.',
        };
      }

      const isGrader = parseGraderFlag(data.isGrader);
      if (isGrader === null) {
        return {
          action: ActionTypes.SAVE_USER,
          error: 'The grader flag has to be yes or no.',
        };
      }

      try {
        // The role travels with the login: memberships are unique on
        // (classroom, user, role), so a user who holds two roles here has two
        // rows and the flag belongs to exactly one of them.
        await ClassmojiService.staff.updateStaff({
          classroomId: classroom.id,
          login,
          role,
          isGrader,
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

      const login = parseLogin(data.login);
      if (!login) {
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Could not tell which staff member that was — reload the page.',
        };
      }

      // Absent means the page offered no choice (it saw no ungraded slots):
      // the service then keeps them, which is what removal always did. A value
      // that is present must be one of the three.
      const ungradedSubmissions = parseUngradedChoice(data.ungradedSubmissions);
      if (ungradedSubmissions === undefined) {
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Pick what happens to their ungraded submissions.',
        };
      }

      let started: StaffRemovalStart;
      let finalStatus: string | undefined;
      try {
        // The service resolves the target from the DB by (classroom, login,
        // role) and builds the task payload entirely server-side. It refuses a
        // missing role or the LAST owner before triggering anything, which is
        // why those failures arrive here rather than inside the task.
        //
        // Whether the ungraded-slot choice applies at all (no grader-flagged
        // ASSISTANT or TEACHER role left afterwards) is decided there too,
        // from the DB — never from what the page believed.
        started = await HelperService.startStaffRemoval({
          classroomId: classroom.id,
          login,
          role,
          ungradedSubmissions,
        });

        finalStatus = (await waitForRunCompletion(started.runId))?.status as string | undefined;
      } catch (error: unknown) {
        // Nothing has been moved yet: slots are settled only after the
        // removal run has succeeded.
        console.error('removeStaff failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: staffErrorMessage(error, 'Failed to remove staff member. Please try again.'),
        };
      }

      // waitForRunCompletion throws on a failed run but hands back undefined
      // when its subscription ends without a terminal run. Only a run KNOWN to
      // have completed may have its slots moved. (With nothing to move, the
      // reply is what it always was.)
      const completed = finalStatus === 'COMPLETED' || finalStatus === 'COMPLETED_SUCCESSFULLY';
      if (started.choice && !completed) {
        return {
          action: ActionTypes.REMOVE_USER,
          error:
            'The removal is still in progress, so their ungraded submissions were not changed. Reload in a moment to check.',
        };
      }

      // The removal is done; now carry out the choice. This never throws —
      // anything it could not change is counted in `failed`.
      const ungraded = started.choice
        ? await HelperService.settleUngradedSlots({
            classroomId: classroom.id,
            graderId: started.userId,
            choice: started.choice,
            departingName: started.name || started.login,
            expectedCount: started.ungradedCount,
          })
        : null;

      return {
        success: removalMessage(ungraded),
        action: ActionTypes.REMOVE_USER,
      };
    },
  });
};
