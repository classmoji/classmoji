/**
 * GitHub Projects API
 *
 * GET /api/github/projects/:class - List organization projects for dropdown
 * Returns: { projects: [{ id: string, title: string, number: number, url: string }] }
 */

import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { getGitProvider } from '@classmoji/services';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;

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
    const projects = await gitProvider.listOrganizationProjects(classroom.git_organization.login);

    return Response.json({ projects });
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const errStatus = (error as { status?: number }).status;
    console.error('[api.github.projects] Error:', errMessage);

    if (errStatus === 401 || errStatus === 403) {
      return Response.json({ error: 'Unauthorized' }, { status: errStatus });
    }

    return Response.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
};
