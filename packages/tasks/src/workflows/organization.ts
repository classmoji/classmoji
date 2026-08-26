import { task } from '@trigger.dev/sdk';
import { ClassmojiService, getGitProvider, getTeamNameForClassroom } from '@classmoji/services';
import { nanoid } from 'nanoid';
import { createRepositoriesTask } from './gitRepo.ts';
import invariant from 'tiny-invariant';

interface MemberAddedPayload {
  membership: { user: { login: string }; [key: string]: unknown };
  organization: { id: number; login: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface GitOrgData {
  id: string;
  login: string;
  provider: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

interface RemoveUserPayload {
  user: { id: string; login: string; has_accepted_invite: boolean };
  gitOrganization?: GitOrgData;
  classroom?: { id: string; slug: string };
  organization?: { id: string; slug: string; git_organization?: GitOrgData };
  role?: 'OWNER' | 'TEACHER' | 'STUDENT' | 'ASSISTANT';
  payload?: RemoveUserPayload;
}

/**
 * Flip `has_accepted_invite` to true and provision any missing student repos for
 * every membership this user holds in the given git organization.
 *
 * This is the single source of truth for "the user is confirmed in the org, so
 * activate them." It is idempotent: repos that already exist are skipped, so it is
 * safe to call more than once (webhook redelivery, retries, re-joins).
 *
 * Called from:
 *  - memberAddedHandlerTask — GitHub `member_added` webhook (brand-new org members)
 *  - the self-join / add-assistant flows when the user is ALREADY in the org, where
 *    no `member_added` webhook ever fires and they'd otherwise be stuck pending.
 */
async function activateMembership({
  login,
  gitOrganizationId,
}: {
  login: string;
  gitOrganizationId: string;
}) {
  const user = await ClassmojiService.user.findByLogin(login);
  if (!user) {
    console.log(`[activateMembership] User not found for login: ${login}`);
    return;
  }

  const gitOrganization = await ClassmojiService.gitOrganization.findById(gitOrganizationId);
  if (!gitOrganization) {
    console.log(`[activateMembership] GitOrganization not found: ${gitOrganizationId}`);
    return;
  }

  // Find all user's memberships in classrooms linked to this git organization
  const userMemberships = await ClassmojiService.classroomMembership.findByUserId(user.id);
  const relevantMemberships = userMemberships.filter(
    m => m.classroom.git_org_id === gitOrganizationId
  );

  if (relevantMemberships.length === 0) {
    console.log(
      `[activateMembership] No memberships found for ${login} in git org ${gitOrganization.login}`
    );
    return;
  }

  for (const membership of relevantMemberships) {
    // By id: the loop already holds each membership row, and a user may hold
    // several roles in one classroom — resolving by (classroom, user) again
    // would activate whichever row came back first, once per iteration.
    await ClassmojiService.classroomMembership.updateById(membership.id, {
      has_accepted_invite: true,
    });

    // Only students get assignment repos
    if (membership.role !== 'STUDENT' || !user.login) {
      continue;
    }

    // Published INDIVIDUAL repositories are what a joining student owes work on.
    // `type` is a field on Repository and never on Assignment, so the previous
    // per-assignment `'type' in assignment` test was always false at runtime and
    // this branch silently provisioned nothing. Selecting on the repository also
    // covers a repository published before any assignment exists (pre-term
    // staging): the student still needs the repo, and the assignment issues are
    // filed later when each assignment releases.
    const repositories = await ClassmojiService.repository.findByClassroomSlug(
      membership.classroom.slug
    );
    const publishedIndividualRepositories = repositories.filter(
      repository => repository.is_published === true && repository.type === 'INDIVIDUAL'
    );

    // Skip repositories whose student repo already exists so re-runs (webhook
    // redelivery, retries, re-joins, users already in the org) don't re-create
    // repos they already have.
    const missingRepositories = [];
    for (const repository of publishedIndividualRepositories) {
      const existingRepos = await ClassmojiService.gitRepo.findByRepository(
        membership.classroom.slug,
        repository.id
      );
      if (!existingRepos.some(repo => repo.student_id === user.id)) {
        missingRepositories.push(repository);
      }
    }

    // Reuse the same provisioning pipeline that publish and Sync drive, scoped to
    // this one student, rather than re-implementing the fanout here. It resolves
    // the template, token and org plan itself and files issues for assignments
    // that have already released. `provisionOnly` keeps the run read-only with
    // respect to publish state: a student joining must never re-publish a repo
    // the instructor unpublished, nor release a draft assignment.
    await Promise.all(
      missingRepositories.map(repository =>
        createRepositoriesTask.trigger(
          {
            logins: [user.login as string],
            assignmentTitle: repository.title,
            org: membership.classroom.slug,
            sessionId: nanoid(),
            provisionOnly: true,
          },
          { concurrencyKey: membership.classroom.slug }
        )
      )
    );
  }
}

/**
 * Task wrapper so non-task callers (webapp routes) can activate a membership via
 * `tasks.trigger('activate_membership', { login, gitOrganizationId })`. Used by the
 * self-join and add-assistant flows when the user is already in the org.
 */
export const activateMembershipTask = task({
  id: 'activate_membership',
  run: async (payload: { login: string; gitOrganizationId: string }) => {
    await activateMembership(payload);
  },
});

export const memberAddedHandlerTask = task({
  id: 'webhook-member_added_handler',
  run: async (payload: MemberAddedPayload) => {
    const {
      membership: { user: githubUser },
      organization: githubOrg,
    } = payload;

    // Look up GitOrganization by GitHub's provider_id
    const gitOrganization = await ClassmojiService.gitOrganization.findByProviderId(
      'GITHUB',
      String(githubOrg.id)
    );

    if (!gitOrganization) {
      console.log(`[member_added] GitOrganization not found for GitHub org: ${githubOrg.login}`);
      return;
    }

    await activateMembership({ login: githubUser.login, gitOrganizationId: gitOrganization.id });
  },
});

export const removeUserFromOrganizationTask = task({
  id: 'remove_user_from_organization',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (arg: RemoveUserPayload) => {
    const payload = arg?.payload ? arg.payload : arg;

    const { user, gitOrganization, classroom, organization, role } = payload;

    // Support both new (classroom/gitOrganization) and legacy (organization) params
    const classroomData = classroom || organization;
    const gitOrgData = gitOrganization || organization?.git_organization;

    invariant(classroomData, '[remove_user] Missing classroom data in payload');
    invariant(gitOrgData, '[remove_user] Missing git organization data in payload');

    if (user.has_accepted_invite) {
      const gitProvider = getGitProvider(gitOrgData);
      const orgLogin = gitOrgData.login;

      // Step 1: Remove user from classroom-specific team, unless another role
      // they still hold in this classroom maps to the SAME team. Every
      // non-student role shares one staff team ({slug}-assistants — see
      // getTeamNameForClassroom), and that team is what grants the staff their
      // repository permission, so it must survive while any of those roles does.
      // The role being removed is excluded from the check by construction, so
      // the answer is the same whether it runs before or after the membership
      // row is deleted below.
      const userRole = role || 'STUDENT';
      const teamSlug = getTeamNameForClassroom(classroomData, userRole);

      const rolesSharingTeam = (['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const).filter(
        other => other !== userRole && getTeamNameForClassroom(classroomData, other) === teamSlug
      );
      const keepsTeam =
        rolesSharingTeam.length > 0 &&
        (await ClassmojiService.classroomMembership.hasRole(
          classroomData.id,
          user.id,
          rolesSharingTeam
        ));

      if (keepsTeam) {
        console.log(
          `[remove_user] User ${user.login} holds another role in ${classroomData.slug} that shares team ${teamSlug}, keeping in team`
        );
      } else {
        try {
          await gitProvider.removeTeamMember(orgLogin, teamSlug, user.login);
        } catch (error: unknown) {
          // Team might not exist or user not in team - log but continue
          console.log(
            `[remove_user] Could not remove ${user.login} from team ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Step 2: Check if user has other classroom memberships in this GitHub org
      const shouldRemoveFromOrg = await ClassmojiService.classroomMembership.shouldRemoveFromGitOrg(
        gitOrgData.id,
        user.id,
        classroomData.id,
        userRole
      );

      // Step 3: Only remove from GitHub org if no other classroom memberships
      if (shouldRemoveFromOrg) {
        await gitProvider.removeFromOrganization(orgLogin, user.login);
      } else {
        console.log(
          `[remove_user] User ${user.login} has other classroom memberships in ${orgLogin}, keeping in org`
        );
      }
    }

    return ClassmojiService.classroomMembership.remove(
      classroomData.id,
      user.id,
      role || 'STUDENT'
    );
  },
});
