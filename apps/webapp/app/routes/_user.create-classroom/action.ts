import { getAuthSession } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';
import { slugify } from './utils';

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const authData = await getAuthSession(request);
  const octokit = GitHubProvider.getUserOctokit(authData!.token!);

  // Get authenticated user
  const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
  const user = await ClassmojiService.user.findByLogin(authenticatedUser.login);

  if (!user) {
    return { error: 'Unauthorized' };
  }

  const { git_org_id, name, slug: slugInput, importConfig } = await request.json();

  if (!name) {
    return { error: 'Classroom name is required' };
  }

  // Get GitOrganization
  const gitOrg = await getPrisma().gitOrganization.findUnique({
    where: { id: git_org_id },
  });

  if (!gitOrg) {
    return { error: 'GitHub organization not found' };
  }

  // Verify user is admin in the selected organization using GraphQL
  try {
    const { organization } = await octokit.graphql<any>(
      `
      query($login: String!) {
        organization(login: $login) {
          login
          viewerCanAdminister
        }
      }
    `,
      {
        login: gitOrg.login,
      }
    );

    if (!organization?.viewerCanAdminister) {
      return {
        error: 'You must be an organization admin to create a classroom',
      };
    }
  } catch (error: unknown) {
    console.error('Error checking org membership:', error instanceof Error ? error.message : error);
    return {
      error: 'Unable to verify organization membership',
    };
  }

  // Slug: prefer client-provided (user override / suggestion) when present, else derive from name.
  const slug = slugInput && typeof slugInput === 'string' ? slugify(slugInput) : slugify(name);

  // Create Classroom, Settings, and Membership in transaction
  const classroom = await getPrisma().$transaction(async tx => {
    const classroom = await tx.classroom.create({
      data: {
        git_org_id,
        slug,
        name,
        content_namespace: slug,
      },
    });

    await tx.classroomSettings.create({
      data: { classroom_id: classroom.id },
    });

    await tx.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: 'OWNER',
        has_accepted_invite: true,
      },
    });

    return classroom;
  });

  // Import repositories if configured
  let importResult = null;
  if (importConfig?.repositories?.length > 0) {
    try {
      importResult = await ClassmojiService.repositoryImport.cloneModulesWithRelations(
        classroom.id,
        importConfig.repositories,
        { stripDeadlines: true }
      );
    } catch (error: unknown) {
      console.error('Error importing repositories:', error);
      // Don't fail classroom creation, just log the error
    }
  }

  // Create per-classroom GitHub teams (e.g., "cs101-25w-students", "cs101-25w-assistants")
  const gitProvider = getGitProvider(gitOrg);

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'STUDENT');
  } catch (error: unknown) {
    console.error(
      `Failed to create students team: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'ASSISTANT');
  } catch (error: unknown) {
    console.error(
      `Failed to create assistants team: ${error instanceof Error ? error.message : error}`
    );
  }

  // Build success message
  let successMessage = 'Classroom created successfully!';
  if (importResult) {
    const parts = [];
    if (importResult.repositories.length > 0) {
      parts.push(
        `${importResult.repositories.length} repository${importResult.repositories.length !== 1 ? 's' : ''}`
      );
    }
    if (importResult.assignments.length > 0) {
      parts.push(
        `${importResult.assignments.length} assignment${importResult.assignments.length !== 1 ? 's' : ''}`
      );
    }
    if (importResult.quizzes.length > 0) {
      parts.push(
        `${importResult.quizzes.length} quiz${importResult.quizzes.length !== 1 ? 'zes' : ''}`
      );
    }
    if (parts.length > 0) {
      successMessage = `Classroom created with ${parts.join(', ')} imported!`;
    }
  }

  return {
    success: successMessage,
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
  };
});
