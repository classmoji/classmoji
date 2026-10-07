import { logger, task } from '@trigger.dev/sdk';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { GITLAB_PROJECTS_SUBGROUP, gitUsername } from '@classmoji/utils';
import {
  ClassmojiService,
  getGitProvider,
  getTeamNameForClassroom,
  type GitLabProvider,
} from '@classmoji/services';
import { nanoid } from 'nanoid';
import { createRepositoriesTask } from './gitRepo.ts';
import invariant from 'tiny-invariant';

interface MemberAddedPayload {
  membership: { user: { id?: number; login: string }; [key: string]: unknown };
  organization: { id: number; login: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ActivateMembershipPayload {
  /** The user's username on the organization's provider (older payloads carry only this). */
  login?: string;
  /** The Github user id (`Account.account_id`), preferred when present. */
  githubUserId?: string;
  gitOrganizationId: string;
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
  user: { id: string; login: string | null; has_accepted_invite: boolean };
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
  githubUserId,
  gitOrganizationId,
}: ActivateMembershipPayload) {
  const gitOrganization = await ClassmojiService.gitOrganization.findById(gitOrganizationId);
  if (!gitOrganization) {
    console.log(`[activateMembership] GitOrganization not found: ${gitOrganizationId}`);
    return;
  }

  // The Github user id is the stable key; a login-only payload (runs queued
  // before ids were sent, or a non-Github org) falls back to the username.
  const user =
    (githubUserId
      ? await ClassmojiService.user.findByGitAccountId(githubUserId, 'GITHUB')
      : null) ??
    (login ? await ClassmojiService.user.findByGitUsername(login, gitOrganization) : null);
  if (!user) {
    console.log(
      `[activateMembership] User not found for ${githubUserId ? `Github id ${githubUserId}` : `login ${login}`}`
    );
    return;
  }
  const username = gitUsername(user, gitOrganization.provider);

  // Find all user's memberships in classrooms linked to this git organization
  const userMemberships = await ClassmojiService.classroomMembership.findByUserId(user.id);
  const relevantMemberships = userMemberships.filter(
    m => m.classroom.git_org_id === gitOrganizationId
  );

  if (relevantMemberships.length === 0) {
    console.log(
      `[activateMembership] No memberships found for ${username ?? user.id} in git org ${gitOrganization.login}`
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
    if (membership.role !== 'STUDENT' || !username) {
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

    // A repository with no template cannot be copied for anyone; trying would
    // fail once for every student who joins. Leave it out and say so once.
    const unusable = publishedIndividualRepositories.filter(r => !r.template?.trim());
    if (unusable.length > 0) {
      logger.warn('Skipping published repositories with no template for a joining student', {
        classroomSlug: membership.classroom.slug,
        repositories: unusable.map(r => r.title),
      });
    }
    const provisionable = publishedIndividualRepositories.filter(r => r.template?.trim());

    // Skip repositories whose student repo already exists so re-runs (webhook
    // redelivery, retries, re-joins, users already in the org) don't re-create
    // repos they already have.
    const missingRepositories = [];
    for (const repository of provisionable) {
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
            logins: [username],
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
 * `tasks.trigger('activate_membership', { login, githubUserId?, gitOrganizationId })`. Used by the
 * self-join and add-assistant flows when the user is already in the org.
 */
/**
 * A student leaving a GitLab classroom: their own projects drop to Reporter
 * (read-only) and they leave every team of the class. Best effort per project
 * and team: one failure is logged and the rest still run.
 */
async function leaveGitLabClassAsStudent(
  classroomId: string,
  userId: string,
  gitOrganization: Parameters<typeof getGitProvider>[0]
): Promise<void> {
  const [classroomRow, usernames] = await Promise.all([
    ClassmojiService.classroom.findById(classroomId),
    ClassmojiService.user.findProviderUsernames([userId], 'GITLAB'),
  ]);
  const gitlabUsername = usernames.get(userId);
  const namespace = classroomRow?.git_namespace
    ? `${classroomRow.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`
    : null;
  if (!namespace || !gitlabUsername) return;
  const provider = getGitProvider(gitOrganization) as GitLabProvider;

  const repos = await getPrisma().gitRepo.findMany({
    where: { classroom_id: classroomId, student_id: userId, provider: 'GITLAB' },
    select: { name: true },
  });
  for (const repo of repos) {
    try {
      await provider.setProjectMemberAccess(namespace, repo.name, gitlabUsername, 'reporter');
    } catch (error: unknown) {
      console.error(`[remove_user] could not make ${namespace}/${repo.name} read-only`, error);
    }
  }

  const user = await ClassmojiService.user.findById(userId);
  const teams = await getPrisma().team.findMany({
    where: { classroom_id: classroomId, memberships: { some: { user_id: userId } } },
    select: { id: true },
  });
  for (const team of teams) {
    try {
      await ClassmojiService.teamAdmin.removeTeamMember({
        classroomId,
        slugOrId: team.id,
        login: user?.login ?? gitlabUsername,
      });
    } catch (error: unknown) {
      console.error(`[remove_user] could not remove the student from team ${team.id}`, error);
    }
  }
}

export const activateMembershipTask = task({
  id: 'activate_membership',
  run: async (payload: ActivateMembershipPayload) => {
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

    await activateMembership({
      login: githubUser.login,
      githubUserId: githubUser.id != null ? String(githubUser.id) : undefined,
      gitOrganizationId: gitOrganization.id,
    });
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

    // GitLab: staff access is membership of the class subgroup (no teams, no
    // org invite), set to the highest staff role the person still holds here.
    // A student who leaves keeps READ access to their own projects (their work
    // stays theirs to see, as on Github) but can no longer push, and leaves
    // the class's teams (which also removes them from team projects).
    if (gitOrgData.provider === 'GITLAB') {
      const userRole = role || 'STUDENT';
      if (userRole === 'STUDENT') {
        await leaveGitLabClassAsStudent(classroomData.id, user.id, gitOrgData);
      } else {
        const [classroomRow, usernames] = await Promise.all([
          ClassmojiService.classroom.findById(classroomData.id),
          ClassmojiService.user.findProviderUsernames([user.id], 'GITLAB'),
        ]);
        const gitlabUsername = usernames.get(user.id);
        const namespace = classroomRow?.git_namespace;
        if (namespace && gitlabUsername) {
          const provider = getGitProvider(gitOrgData) as GitLabProvider;
          const remaining = (['OWNER', 'TEACHER', 'ASSISTANT'] as const).filter(
            other => other !== userRole
          );
          const stillHeld: Array<(typeof remaining)[number]> = [];
          for (const other of remaining) {
            if (
              await ClassmojiService.classroomMembership.hasRole(classroomData.id, user.id, [other])
            ) {
              stillHeld.push(other);
            }
          }
          if (stillHeld.length === 0) {
            await provider.removeGroupMember(namespace, gitlabUsername);
          } else {
            const level = Math.max(
              ...stillHeld.map(r => ClassmojiService.staff.GITLAB_STAFF_ACCESS[r])
            );
            await provider.addGroupMember(namespace, gitlabUsername, level);
          }
        }
      }
      return ClassmojiService.classroomMembership.remove(classroomData.id, user.id, userRole);
    }

    // The username on the org's provider, read from the stored account; the
    // payload's `login` is what the caller resolved and covers a deleted user.
    const storedUser = await getPrisma().user.findUnique({
      where: { id: user.id },
      select: { ...GIT_IDENTITY },
    });
    const username = gitUsername(storedUser, gitOrgData.provider) ?? user.login;

    if (user.has_accepted_invite && !username) {
      console.log(
        `[remove_user] User ${user.id} has no ${gitOrgData.provider} username, skipping git removal`
      );
    } else if (user.has_accepted_invite && username) {
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
          `[remove_user] User ${username} holds another role in ${classroomData.slug} that shares team ${teamSlug}, keeping in team`
        );
      } else {
        try {
          await gitProvider.removeTeamMember(orgLogin, teamSlug, username);
        } catch (error: unknown) {
          // Team might not exist or user not in team - log but continue
          console.log(
            `[remove_user] Could not remove ${username} from team ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
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
        await gitProvider.removeFromOrganization(orgLogin, username);
      } else {
        console.log(
          `[remove_user] User ${username} has other classroom memberships in ${orgLogin}, keeping in org`
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
