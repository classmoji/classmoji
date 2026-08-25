/**
 * Assistant (TA) Service
 *
 * Add / update / remove a classroom ASSISTANT. Shared by the web
 * admin.$class.assistants action and the MCP assistant tools so both take one
 * code path (same precedent as roster.service.ts).
 *
 * The GitHub profile is resolved SERVER-SIDE from the login: the web form used
 * to resolve it client-side with the instructor's octokit and post the profile,
 * which an MCP caller cannot do (it only has a login) and which let a client
 * choose the provider_id the membership is keyed to.
 *
 * Trigger.dev tasks are fired via the raw `@trigger.dev/sdk` string ids (this
 * package cannot import @classmoji/tasks — tasks already depends on services).
 * `removeAssistant` returns the trigger HANDLE rather than awaiting it: the web
 * route streams progress with waitForRunCompletion, MCP fires and forgets.
 */
import { tasks } from '@trigger.dev/sdk';

import getPrisma from '@classmoji/database';
import { getGitProvider, ensureClassroomTeam } from '../git/index.ts';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as userService from './user.service.ts';

export interface AddAssistantResult {
  /** false when an ASSISTANT membership already existed (no-op, not an error). */
  created: boolean;
  alreadyExists: boolean;
  userId: string;
  login: string;
  name: string | null;
  /** true when the user was already in the GitHub org (team-added + activated). */
  alreadyOrgMember: boolean;
}

export interface RemoveAssistantResult {
  userId: string;
  login: string;
  /** Trigger.dev run handle — await it (waitForRunCompletion) or ignore it. */
  runId: string;
}

/** Thrown for every caller-fixable failure so routes/tools can map it to a message. */
export class AssistantServiceError extends Error {
  code: 'classroom_not_found' | 'git_user_not_found' | 'assistant_not_found' | 'no_org_configured';

  constructor(code: AssistantServiceError['code'], message: string) {
    super(message);
    this.name = 'AssistantServiceError';
    this.code = code;
  }
}

const loadClassroom = async (classroomId: string) => {
  const classroom = await classroomService.findById(classroomId);
  if (!classroom) {
    throw new AssistantServiceError(
      'classroom_not_found',
      `[assistant] classroom ${classroomId} not found`
    );
  }
  if (!classroom.git_organization) {
    throw new AssistantServiceError(
      'no_org_configured',
      `[assistant] classroom ${classroomId} has no git organization`
    );
  }
  return classroom;
};

/**
 * Add a GitHub user as an ASSISTANT of a classroom.
 *
 * Resolves the login against the git provider, ensures the classroom assistant
 * team exists, adds (already-org-members) or invites (everyone else) them, then
 * upserts the User + Account and creates the ASSISTANT membership.
 *
 * Idempotent: an existing ASSISTANT membership in this classroom returns
 * `{ created: false, alreadyExists: true }` instead of a unique-constraint
 * error. `name`/`email` are the instructor-supplied overrides from the web form;
 * when omitted the git profile's name and email are used.
 */
export const addAssistant = async ({
  classroomId,
  login,
  name,
  email,
}: {
  classroomId: string;
  login: string;
  name?: string | null;
  email?: string | null;
}): Promise<AddAssistantResult> => {
  const classroom = await loadClassroom(classroomId);
  const gitOrganization = classroom.git_organization;
  const cleanLogin = login.replace('@', '').trim();

  // Idempotency BEFORE any GitHub write: re-inviting an existing assistant
  // would re-add them to the team and then still fail on the unique constraint.
  const existingUser = await getPrisma().user.findUnique({
    where: { login: cleanLogin },
    select: { id: true, login: true, name: true },
  });
  if (existingUser) {
    const existingMembership = await classroomMembershipService.findByClassroomAndUser(
      classroomId,
      existingUser.id,
      'ASSISTANT'
    );
    if (existingMembership) {
      return {
        created: false,
        alreadyExists: true,
        userId: existingUser.id,
        login: existingUser.login ?? cleanLogin,
        name: existingUser.name,
        alreadyOrgMember: true,
      };
    }
  }

  const gitProvider = getGitProvider(gitOrganization);

  let gitUser: { id: number | string; login: string; name?: string | null; email?: string | null };
  try {
    gitUser = await gitProvider.getUserByLogin(cleanLogin);
  } catch (error: unknown) {
    throw new AssistantServiceError(
      'git_user_not_found',
      `[assistant] git user ${cleanLogin} not found: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!gitUser?.login) {
    throw new AssistantServiceError(
      'git_user_not_found',
      `[assistant] git user ${cleanLogin} not found`
    );
  }

  const team = await ensureClassroomTeam(
    gitProvider,
    gitOrganization.login,
    classroom,
    'ASSISTANT'
  );

  // If the assistant is already in the org, a fresh invite 422s and no `member_added`
  // webhook fires — so just add them to the assistant team and activate them below.
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
      console.error('Error inviting assistant to organization:', error);
    }
  }

  // Upsert user and account, then create the ASSISTANT membership.
  const user = await getPrisma().user.upsert({
    where: { login: gitUser.login },
    create: {
      login: gitUser.login,
      name: name || gitUser.name || gitUser.login,
      provider: gitOrganization.provider as 'GITHUB' | 'GITLAB' | 'BITBUCKET',
      provider_id: String(gitUser.id),
      role: 'user',
      email: email ?? null,
      provider_email: gitUser.email ?? null,
    },
    update: {
      role: 'user',
    },
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

  await getPrisma().classroomMembership.create({
    data: {
      classroom_id: classroom.id,
      user_id: user.id,
      role: 'ASSISTANT',
    },
  });

  // Already-in-org assistants get no `member_added` webhook, so flip
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
    alreadyOrgMember: alreadyMember,
  };
};

/**
 * Flip the is_grader flag on a user's ASSISTANT membership.
 *
 * Role-scoped on purpose: the membership unique key is
 * (classroom_id, user_id, role), so a user who is both OWNER and ASSISTANT has
 * two rows and the generic membership update (findFirst, no role filter) could
 * pick the wrong one.
 */
export const updateAssistant = async ({
  classroomId,
  login,
  isGrader,
}: {
  classroomId: string;
  login: string;
  isGrader: boolean;
}) => {
  const user = await userService.findByLogin(login);
  if (!user) {
    throw new AssistantServiceError('assistant_not_found', `[assistant] user ${login} not found`);
  }

  const membership = await classroomMembershipService.findByClassroomAndUser(
    classroomId,
    user.id,
    'ASSISTANT'
  );
  if (!membership) {
    throw new AssistantServiceError(
      'assistant_not_found',
      `[assistant] ${login} is not an assistant of classroom ${classroomId}`
    );
  }

  return classroomMembershipService.updateById(membership.id, { is_grader: isGrader });
};

/**
 * Queue removal of an ASSISTANT from a classroom.
 *
 * The `remove_user_from_organization` task is the single source of truth and is
 * role-aware: it removes the classroom's ASSISTANT team membership, removes the
 * user from the GitHub org ONLY when they hold no other membership in that org
 * (the (classroom, ASSISTANT) pair being removed is the only one excluded from
 * the count — an OWNER/STUDENT row in the same classroom keeps them in), and
 * deletes only the ASSISTANT membership row.
 *
 * The payload is built ENTIRELY from resolved DB records — `has_accepted_invite`
 * is a MEMBERSHIP field, not a user field. Returns the run handle; the caller
 * decides whether to await it.
 */
export const removeAssistant = async ({
  classroomId,
  login,
}: {
  classroomId: string;
  login: string;
}): Promise<RemoveAssistantResult> => {
  const classroom = await loadClassroom(classroomId);

  const user = await userService.findByLogin(login);
  if (!user) {
    throw new AssistantServiceError('assistant_not_found', `[assistant] user ${login} not found`);
  }

  // The target must be an ASSISTANT in THIS classroom — never touch the
  // memberships another role of the same user holds here.
  const membership = await classroomMembershipService.findByClassroomAndUser(
    classroomId,
    user.id,
    'ASSISTANT'
  );
  if (!membership) {
    throw new AssistantServiceError(
      'assistant_not_found',
      `[assistant] ${login} is not an assistant of classroom ${classroomId}`
    );
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
      role: 'ASSISTANT',
    },
  });

  return { userId: user.id, login: user.login ?? login, runId: run.id };
};
