import { task } from '@trigger.dev/sdk';
import { ClassmojiService, getGitProvider, getTeamNameForClassroom, ensureClassroomTeam } from '@classmoji/services';
import { sendEmailTask } from './email.js';
import { createRepositoryTask } from './repository.js';
import invariant from 'tiny-invariant';

export const memberAddedHandlerTask = task({
  id: 'webhook-member_added_handler',
  run: async payload => {
    const {
      membership: { user: githubUser },
      organization: githubOrg,
    } = payload;

    // Find the user by their GitHub login
    const user = await ClassmojiService.user.findByLogin(githubUser.login);
    if (!user) {
      console.log(`[member_added] User not found for login: ${githubUser.login}`);
      return;
    }

    // Look up GitOrganization by GitHub's provider_id
    const gitOrganization = await ClassmojiService.gitOrganization.findByProviderId(
      'GITHUB',
      String(githubOrg.id)
    );

    if (!gitOrganization) {
      console.log(`[member_added] GitOrganization not found for GitHub org: ${githubOrg.login}`);
      return;
    }

    // Find all user's memberships in classrooms linked to this git organization
    const userMemberships = await ClassmojiService.classroomMembership.findByUserId(user.id);
    const relevantMemberships = userMemberships.filter(
      m => m.classroom.git_org_id === gitOrganization.id
    );

    if (relevantMemberships.length === 0) {
      console.log(`[member_added] No memberships found for user ${user.login} in git org ${gitOrganization.login}`);
      return;
    }

    // Update all relevant memberships
    for (const membership of relevantMemberships) {
      await ClassmojiService.classroomMembership.update(
        membership.classroom_id,
        user.id,
        { has_accepted_invite: true }
      );

      // Create existing assignments for new students
      if (membership.role === 'STUDENT') {
        const modules = await ClassmojiService.module.findByClassroomSlug(membership.classroom.slug);
        const assignments = modules.flatMap(module =>
          module.assignments
            .filter(({ is_published, type }) => is_published === true && type === 'INDIVIDUAL')
            .map(assignment => ({ ...assignment, module }))
        );

        const promises = assignments.map(async assignment => {
          const [templateOwner, templateRepo] = assignment.module.template.split('/');
          const repoName = `${assignment.module.slug}-${user.login}`;

          const createRepoTaskData = {
            templateOwner,
            templateRepo,
            organization: membership.classroom,
            repoName,
            assignment,
            student: user,
          };

          return createRepositoryTask.trigger(createRepoTaskData, {
            concurrencyKey: gitOrganization.login,
          });
        });

        await Promise.all(promises);
      }
    }
  },
});

export const removeUserFromOrganizationTask = task({
  id: 'remove_user_from_organization',
  queue: {
    concurrencyLimit: 6,
  },
  run: async arg => {
    const payload = arg?.payload ? arg.payload : arg;

    const { user, gitOrganization, classroom, organization, role } = payload;

    // Support both new (classroom/gitOrganization) and legacy (organization) params
    const classroomData = classroom || organization;
    const gitOrgData = gitOrganization || organization?.git_organization;

    if (user.has_accepted_invite) {
      const gitProvider = getGitProvider(gitOrgData);
      const orgLogin = gitOrgData.login;

      // Step 1: Remove user from classroom-specific team
      const userRole = role || 'STUDENT';
      const teamSlug = getTeamNameForClassroom(classroomData, userRole);
      try {
        await gitProvider.removeTeamMember(orgLogin, teamSlug, user.login);
      } catch (error) {
        // Team might not exist or user not in team - log but continue
        console.log(`[remove_user] Could not remove ${user.login} from team ${teamSlug}: ${error.message}`);
      }

      // Step 2: Check if user has other classroom memberships in this GitHub org
      const shouldRemoveFromOrg = await ClassmojiService.classroomMembership.shouldRemoveFromGitOrg(
        gitOrgData.id,
        user.id,
        classroomData.id
      );

      // Step 3: Only remove from GitHub org if no other classroom memberships
      if (shouldRemoveFromOrg) {
        await gitProvider.removeFromOrganization(orgLogin, user.login);
      } else {
        console.log(`[remove_user] User ${user.login} has other classroom memberships in ${orgLogin}, keeping in org`);
      }
    }

    return ClassmojiService.classroomMembership.remove(classroomData.id, user.id);
  },
});
