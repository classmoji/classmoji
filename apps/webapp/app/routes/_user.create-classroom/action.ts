import { getAuthSession } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
  classroomService,
} from '@classmoji/services';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const authData = await getAuthSession(request);
  const octokit = GitHubProvider.getUserOctokit(authData!.token!);

  // Get authenticated user
  const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
  const user = await ClassmojiService.user.findByLogin(authenticatedUser.login);

  if (!user) {
    return { error: 'Unauthorized' };
  }

  const { git_org_id, name, term, year, importConfig } = await request.json();

  if (!term || !year) {
    return { error: 'Term and year are required' };
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

  // Generate unique slug (name, term, year - no gitOrg)
  const slug = await classroomService.generateSlug(name, term, year);

  // Create Classroom, Settings, and Membership in transaction
  const classroom = await getPrisma().$transaction(async tx => {
    const classroom = await tx.classroom.create({
      data: {
        git_org_id,
        slug,
        name,
        term,
        year: Number(year),
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

  // Import modules if configured
  let importResult = null;
  if (importConfig?.modules?.length > 0) {
    try {
      importResult = await ClassmojiService.moduleImport.cloneModulesWithRelations(
        classroom.id,
        importConfig.modules,
        { stripDeadlines: true }
      );
    } catch (error: unknown) {
      console.error('Error importing modules:', error);
      // Don't fail classroom creation, just log the error
    }
  }

  // Create per-classroom GitHub teams (e.g., "cs101-25w-students", "cs101-25w-assistants")
  const gitProvider = getGitProvider(gitOrg);

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'STUDENT');
  } catch (error: unknown) {
    console.error(`Failed to create students team: ${error instanceof Error ? error.message : error}`);
  }

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'ASSISTANT');
  } catch (error: unknown) {
    console.error(`Failed to create assistants team: ${error instanceof Error ? error.message : error}`);
  }

  // Build success message
  let successMessage = 'Classroom created successfully!';
  if (importResult) {
    const parts = [];
    if (importResult.modules.length > 0) {
      parts.push(
        `${importResult.modules.length} module${importResult.modules.length !== 1 ? 's' : ''}`
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
