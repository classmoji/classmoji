/**
 * GitHub Projects API
 *
 * GET /api/github/projects/:class - List organization projects for dropdown
 * Returns: { projects: [{ id: string, title: string, number: number, url: string }] }
 */

import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { getGitProvider } from '@classmoji/services';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  try {
    const { classroom } = await requireClassroomAdmin(request, classSlug, {
      resourceType: 'GITHUB_PROJECTS',
      action: 'list_projects',
    });

    if (!classroom.git_organization) {
      return Response.json(
        { error: 'No GitHub organization connected to this classroom' },
        { status: 400 }
      );
    }

    const gitProvider = getGitProvider(classroom.git_organization);
    const projects = await gitProvider.listOrganizationProjects(
      classroom.git_organization.login
    );

    return Response.json({ projects });
  } catch (error) {
    console.error('[api.github.projects] Error:', error.message);

    if (error.status === 401 || error.status === 403) {
      return Response.json(
        { error: 'Unauthorized' },
        { status: error.status }
      );
    }

    return Response.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
};
