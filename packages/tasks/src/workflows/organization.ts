import { task } from '@trigger.dev/sdk';
import { ClassmojiService, getGitProvider, getTeamNameForClassroom } from '@classmoji/services';
import { createRepositoryTask } from './gitRepo.ts';
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
    await ClassmojiService.classroomMembership.update(membership.classroom_id, user.id, {
      has_accepted_invite: true,
    });

    // Only students get assignment repos
    if (membership.role !== 'STUDENT' || !user.login) {
      continue;
    }

    const repositories = await ClassmojiService.repository.findByClassroomSlug(
      membership.classroom.slug
    );
    const assignments = repositories.flatMap(repository =>
      repository.assignments
        .filter(a => a.is_published === true && 'type' in a && a.type === 'INDIVIDUAL')
        .map(assignment => ({ ...assignment, repository }))
    );

    // Skip assignments whose student repo already exists so re-runs (and users who
    // were already in the org) don't try to re-create repos they already have.
    const existingByRepository = new Map<string, { student_id: string | null }[]>();
    for (const { repository } of assignments) {
      if (!existingByRepository.has(repository.id)) {
        existingByRepository.set(
          repository.id,
          await ClassmojiService.gitRepo.findByRepository(membership.classroom.slug, repository.id)
        );
      }
    }
    const missingAssignments = assignments.filter(assignment => {
      const existing = existingByRepository.get(assignment.repository.id) ?? [];
      return !existing.some(repo => repo.student_id === user.id);
    });

    await Promise.all(
      missingAssignments.map(assignment => {
        const [templateOwner, templateRepo] = assignment.repository.template.split('/');
        return createRepositoryTask.trigger(
          {
            templateOwner,
            templateRepo,
            organization: membership.classroom,
            repoName: `${assignment.repository.slug}-${user.login}`,
            assignment,
            student: user,
          },
          { concurrencyKey: gitOrganization.login }
        );
      })
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

      // Step 1: Remove user from classroom-specific team
      const userRole = role || 'STUDENT';
      const teamSlug = getTeamNameForClassroom(classroomData, userRole);
      try {
        await gitProvider.removeTeamMember(orgLogin, teamSlug, user.login);
      } catch (error: unknown) {
        // Team might not exist or user not in team - log but continue
        console.log(
          `[remove_user] Could not remove ${user.login} from team ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
        );
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
