/**
 * GitHub Repos API - Lists repositories in a classroom's GitHub organization
 *
 * Used by instructors to select a test repository for code-aware quiz preview.
 * Only OWNER and ASSISTANT roles can access this endpoint.
 */
import { Octokit } from '@octokit/rest';
import { assertClassroomAccess } from '~/utils/helpers';
import { getInstallationToken } from '~/routes/student.$class.quizzes/helpers.server';

export async function loader({ request }) {
  const url = new URL(request.url);
  const classroomSlug = url.searchParams.get('classroomSlug');

  if (!classroomSlug) {
    return new Response(JSON.stringify({ error: 'classroomSlug is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify user is OWNER or ASSISTANT
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'GITHUB_REPOS',
    attemptedAction: 'list',
  });

  // Check if classroom has a git organization configured
  if (!classroom.git_organization) {
    return new Response(JSON.stringify({ error: 'No GitHub organization configured for this classroom' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const gitOrg = classroom.git_organization;
    const token = await getInstallationToken(gitOrg);
    const octokit = new Octokit({ auth: token });

    // List repos in the organization, sorted by most recently updated
    const { data: repos } = await octokit.repos.listForOrg({
      org: gitOrg.login,
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    });

    // Return simplified repo list
    const repoList = repos.map(r => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      updated_at: r.updated_at,
    }));

    return new Response(JSON.stringify(repoList), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api.github-repos] Error fetching repos:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch repositories' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
