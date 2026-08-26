/**
 * Teaching-staff Service
 *
 * Add / update / remove a classroom staff member at ASSISTANT, TEACHER or
 * OWNER. Shared by the web admin.$class.assistants action (which asks for
 * ASSISTANT) and the MCP staff tools so both take one code path (same
 * precedent as roster.service.ts).
 *
 * MULTI-ROLE SEMANTICS: memberships are unique on (classroom_id, user_id,
 * role), so a user may legitimately hold several roles in one classroom.
 * Adding a role to someone who already holds a DIFFERENT role therefore GRANTS
 * AN ADDITIONAL role — it never replaces the existing one, and the existing
 * row is left untouched. Every lookup here is scoped to the requested role for
 * the same reason: the idempotency pre-check, the update and the removal must
 * each see only the row they are about to act on. `resolveHighestMembership`
 * (packages/auth) means such a user is treated at their HIGHEST role.
 *
 * The GitHub profile is resolved SERVER-SIDE from the login: the web form used
 * to resolve it client-side with the instructor's octokit and post the profile,
 * which an MCP caller cannot do (it only has a login) and which let a client
 * choose the provider_id the membership is keyed to.
 *
 * All non-student roles share ONE GitHub staff team ({slug}-assistants) — see
 * getTeamNameForClassroom in ../git/index.ts.
 *
 * Trigger.dev tasks are fired via the raw `@trigger.dev/sdk` string ids (this
 * package cannot import @classmoji/tasks — tasks already depends on services).
 * `removeStaff` returns the trigger HANDLE rather than awaiting it: the web
 * route streams progress with waitForRunCompletion, MCP fires and forgets.
 */
import { tasks } from '@trigger.dev/sdk';

import getPrisma from '@classmoji/database';
import { getGitProvider, ensureClassroomTeam } from '../git/index.ts';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as userService from './user.service.ts';

/** The roles this service manages. STUDENT is the roster service's business. */
export type StaffRole = 'ASSISTANT' | 'TEACHER' | 'OWNER';

export interface AddStaffResult {
  /** false when a membership at the REQUESTED role already existed (no-op, not an error). */
  created: boolean;
  alreadyExists: boolean;
  userId: string;
  login: string;
  name: string | null;
  /** The role that was granted (echoed back so callers can audit it). */
  role: StaffRole;
  /** true when the user was already in the GitHub org (team-added + activated). */
  alreadyOrgMember: boolean;
}

export interface RemoveStaffResult {
  userId: string;
  login: string;
  role: StaffRole;
  /** Trigger.dev run handle — await it (waitForRunCompletion) or ignore it. */
  runId: string;
}

/** Thrown for every caller-fixable failure so routes/tools can map it to a message. */
export class StaffServiceError extends Error {
  code:
    | 'classroom_not_found'
    | 'git_user_not_found'
    | 'staff_not_found'
    | 'no_org_configured'
    | 'login_conflict'
    | 'last_owner'
    | 'grader_flag_invalid';

  constructor(code: StaffServiceError['code'], message: string) {
    super(message);
    this.name = 'StaffServiceError';
    this.code = code;
  }
}

/** A git provider 404 — the login genuinely names nobody (same shape the providers throw). */
const isProviderNotFound = (error: unknown): boolean =>
  error instanceof Error &&
  'status' in error &&
  (error as Error & { status: number }).status === 404;

/** A Prisma unique-constraint violation (e.g. the membership already exists). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

const loadClassroom = async (classroomId: string) => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new StaffServiceError('classroom_not_found', `[staff] classroom ${classroomId} not found`);
  }
  if (!classroom.git_organization) {
    throw new StaffServiceError(
      'no_org_configured',
      `[staff] classroom ${classroomId} has no git organization`
    );
  }
  return classroom;
};

/**
 * Add a GitHub user to a classroom's teaching staff at `role`.
 *
 * Resolves the login against the git provider, ensures the classroom staff
 * team exists, adds (already-org-members) or invites (everyone else) them, then
 * upserts the User + Account and creates the membership at the requested role.
 *
 * Idempotent PER ROLE: an existing membership at THIS role in this classroom
 * returns `{ created: false, alreadyExists: true }` instead of a
 * unique-constraint error. A membership at a DIFFERENT role is not a conflict —
 * the new role is granted alongside it. `name`/`email` are the
 * instructor-supplied overrides from the web form; when omitted the git
 * profile's name and email are used.
 */
export const addStaff = async ({
  classroomId,
  login,
  role,
  name,
  email,
}: {
  classroomId: string;
  login: string;
  role: StaffRole;
  name?: string | null;
  email?: string | null;
}): Promise<AddStaffResult> => {
  const classroom = await loadClassroom(classroomId);
  const gitOrganization = classroom.git_organization;
  const cleanLogin = login.replace('@', '').trim();

  // Idempotency BEFORE any GitHub write: re-inviting existing staff would
  // re-add them to the team and then still fail on the unique constraint.
  // Git logins are case-insensitive while Postgres is not, so match the stored
  // login insensitively — 'Ada' and 'ada' are the same person. Scoped to the
  // REQUESTED role: another role held here is an additional grant, not a no-op.
  const existingUser = await getPrisma().user.findFirst({
    where: { login: { equals: cleanLogin, mode: 'insensitive' } },
    select: { id: true, login: true, name: true },
  });
  if (existingUser) {
    const existingMembership = await classroomMembershipService.findByClassroomAndUser(
      classroomId,
      existingUser.id,
      role
    );
    if (existingMembership) {
      return {
        created: false,
        alreadyExists: true,
        userId: existingUser.id,
        login: existingUser.login ?? cleanLogin,
        name: existingUser.name,
        role,
        alreadyOrgMember: true,
      };
    }
  }

  const gitProvider = getGitProvider(gitOrganization);

  let gitUser: { id: number | string; login: string; name?: string | null; email?: string | null };
  try {
    gitUser = await gitProvider.getUserByLogin(cleanLogin);
  } catch (error: unknown) {
    // Only a 404 means the username is wrong. A rate limit, a network blip or a
    // bad token must surface as itself — telling the operator "no such user"
    // would send them off fixing a name that was never the problem.
    if (!isProviderNotFound(error)) throw error;
    throw new StaffServiceError('git_user_not_found', `[staff] git user ${cleanLogin} not found`);
  }
  if (!gitUser?.login) {
    throw new StaffServiceError('git_user_not_found', `[staff] git user ${cleanLogin} not found`);
  }

  // The provider hands back the canonical casing, which may differ from what the
  // caller typed. Re-check with it BEFORE any GitHub write (ensureClassroomTeam
  // creates the team) so a differently-cased login is still a no-op.
  const canonicalUser = await getPrisma().user.findFirst({
    where: { login: { equals: gitUser.login, mode: 'insensitive' } },
    select: { id: true, login: true, name: true, provider_id: true },
  });

  if (canonicalUser) {
    // The stored row is keyed to a different provider account than the one this
    // login resolves to today — refuse rather than relink the existing record.
    if (canonicalUser.provider_id && canonicalUser.provider_id !== String(gitUser.id)) {
      throw new StaffServiceError(
        'login_conflict',
        `[staff] login ${gitUser.login} resolves to a different provider account than the stored user record`
      );
    }

    const existingMembership = await classroomMembershipService.findByClassroomAndUser(
      classroomId,
      canonicalUser.id,
      role
    );
    if (existingMembership) {
      return {
        created: false,
        alreadyExists: true,
        userId: canonicalUser.id,
        login: canonicalUser.login ?? gitUser.login,
        name: canonicalUser.name,
        role,
        alreadyOrgMember: true,
      };
    }
  }

  // Every non-student role shares the one staff team, so this is the same team
  // whether the new member is an assistant, a teacher or a co-owner.
  const team = await ensureClassroomTeam(gitProvider, gitOrganization.login, classroom, role);

  // If they are already in the org, a fresh invite 422s and no `member_added`
  // webhook fires — so just add them to the staff team and activate them below.
  // Otherwise send the org invite as usual.
  const alreadyMember = await gitProvider.isUserMemberOfOrganization(
    gitOrganization.login,
    gitUser.login
  );

  if (alreadyMember) {
    await gitProvider.addTeamMember(gitOrganization.login, team.slug, gitUser.login);
  } else {
    try {
      await gitProvider.inviteToOrganization(gitOrganization.login, String(gitUser.id), [team.id]);
    } catch (error: unknown) {
      console.error('Error inviting staff member to organization:', error);
    }
  }

  // Upsert user and account, then create the membership at the requested role.
  // Target an already-known row by id: `where: { login }` is an exact match, so
  // a row stored under different casing would be missed and duplicated.
  // `update: {}` on purpose — adding someone as staff must not rewrite any
  // field of a user record that already exists.
  const user = await getPrisma().user.upsert({
    where: canonicalUser ? { id: canonicalUser.id } : { login: gitUser.login },
    create: {
      login: gitUser.login,
      name: name || gitUser.name || gitUser.login,
      provider: gitOrganization.provider as 'GITHUB' | 'GITLAB' | 'BITBUCKET',
      provider_id: String(gitUser.id),
      role: 'user',
      email: email ?? null,
      provider_email: gitUser.email ?? null,
    },
    update: {},
  });

  await getPrisma().account.upsert({
    where: {
      provider_id_account_id: {
        provider_id: gitOrganization.provider.toLowerCase(),
        account_id: String(gitUser.id),
      },
    },
    create: {
      provider_id: gitOrganization.provider.toLowerCase(),
      account_id: String(gitUser.id),
      user_id: String(user.id),
    },
    update: {},
  });

  try {
    await getPrisma().classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: user.id,
        role,
      },
    });
  } catch (error: unknown) {
    // Last line of defence for the idempotency contract: if the membership row
    // turned up anyway (a concurrent add, or a lookup that missed it), report
    // the same already-exists result rather than a generic failure.
    if (!isUniqueViolation(error)) throw error;
    return {
      created: false,
      alreadyExists: true,
      userId: user.id,
      login: user.login ?? gitUser.login,
      name: user.name,
      role,
      alreadyOrgMember: alreadyMember,
    };
  }

  // Already-in-org staff get no `member_added` webhook, so flip
  // has_accepted_invite now that the membership exists.
  if (alreadyMember) {
    await tasks.trigger('activate_membership', {
      login: gitUser.login,
      gitOrganizationId: gitOrganization.id,
    });
  }

  return {
    created: true,
    alreadyExists: false,
    userId: user.id,
    login: user.login ?? gitUser.login,
    name: user.name,
    role,
    alreadyOrgMember: alreadyMember,
  };
};

/**
 * Flip the is_grader flag on a user's membership at `role`.
 *
 * Role-scoped on purpose: the membership unique key is
 * (classroom_id, user_id, role), so a user who is both OWNER and ASSISTANT has
 * two rows and the generic membership update (findFirst, no role filter) could
 * pick the wrong one.
 *
 * `is_grader` is only meaningful for people who grade, and the RANDOM
 * bulk-assignment pool draws from ASSISTANT + TEACHER rows only — so flagging
 * an OWNER row would set a flag nothing reads. Refused with `grader_flag_invalid`.
 */
export const updateStaff = async ({
  classroomId,
  login,
  role,
  isGrader,
}: {
  classroomId: string;
  login: string;
  role: StaffRole;
  isGrader: boolean;
}) => {
  if (role === 'OWNER') {
    throw new StaffServiceError(
      'grader_flag_invalid',
      '[staff] is_grader applies to ASSISTANT and TEACHER memberships only'
    );
  }

  const user = await userService.findByLogin(login);
  if (!user) {
    throw new StaffServiceError('staff_not_found', `[staff] user ${login} not found`);
  }

  const membership = await classroomMembershipService.findByClassroomAndUser(
    classroomId,
    user.id,
    role
  );
  if (!membership) {
    throw new StaffServiceError(
      'staff_not_found',
      `[staff] ${login} does not hold the ${role} role in classroom ${classroomId}`
    );
  }

  return classroomMembershipService.updateById(membership.id, { is_grader: isGrader });
};

/**
 * Queue removal of a staff member's `role` membership from a classroom.
 *
 * The `remove_user_from_organization` task is the single source of truth and is
 * role-aware: it removes the classroom's staff team membership on GitHub,
 * removes the user from the GitHub org ONLY when they hold no other membership
 * in that org (the (classroom, role) pair being removed is the only one excluded
 * from the count — any other row in the same classroom keeps them in), and
 * deletes only the membership row at that role.
 *
 * LAST-OWNER PRE-CHECK: the removal itself runs asynchronously, so the
 * downstream `assertNotLastOwner` guard inside classroomMembership.remove would
 * throw inside the task long after this call reported success. Check the owner
 * count HERE, before triggering, so the caller learns about it. The downstream
 * guard stays as well — belt and braces.
 *
 * The payload is built ENTIRELY from resolved DB records — `has_accepted_invite`
 * is a MEMBERSHIP field, not a user field. Returns the run handle; the caller
 * decides whether to await it.
 */
export const removeStaff = async ({
  classroomId,
  login,
  role,
}: {
  classroomId: string;
  login: string;
  role: StaffRole;
}): Promise<RemoveStaffResult> => {
  const classroom = await loadClassroom(classroomId);

  const user = await userService.findByLogin(login);
  if (!user) {
    throw new StaffServiceError('staff_not_found', `[staff] user ${login} not found`);
  }

  // The target must hold THIS role in THIS classroom — never touch the
  // memberships another role of the same user holds here.
  const membership = await classroomMembershipService.findByClassroomAndUser(
    classroomId,
    user.id,
    role
  );
  if (!membership) {
    throw new StaffServiceError(
      'staff_not_found',
      `[staff] ${login} does not hold the ${role} role in classroom ${classroomId}`
    );
  }

  // Refuse to orphan the classroom BEFORE the fire-and-forget trigger.
  if (role === 'OWNER') {
    const ownerCount = await getPrisma().classroomMembership.count({
      where: { classroom_id: classroomId, role: 'OWNER' },
    });
    if (ownerCount <= 1) {
      throw new StaffServiceError(
        'last_owner',
        `[staff] ${login} is the only owner of classroom ${classroomId}`
      );
    }
  }

  const run = await tasks.trigger('remove_user_from_organization', {
    payload: {
      user: {
        id: user.id,
        login: user.login,
        has_accepted_invite: membership.has_accepted_invite,
      },
      gitOrganization: classroom.git_organization,
      classroom,
      role,
    },
  });

  return { userId: user.id, login: user.login ?? login, role, runId: run.id };
};
