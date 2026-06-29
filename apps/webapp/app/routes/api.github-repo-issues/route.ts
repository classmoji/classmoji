/**
 * GitHub Repo Issues API - Lists open issues for a template repository.
 *
 * Used by the assignment form to prefill assignment titles from a template's
 * GitHub issues. Authenticated with the classroom org installation token, so it
 * works for private templates the instructor's personal token can't read.
 *
 * Only OWNER and ASSISTANT roles can access this endpoint.
 */
import { Octokit } from '@octokit/rest';
import { assertClassroomAccess } from '~/utils/helpers';
import { getInstallationToken } from '~/routes/student.$class.quizzes/helpers.server';
import type { Route } from './+types/route';

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const classroomSlug = url.searchParams.get('classroomSlug');
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');

  if (!classroomSlug || !owner || !repo) {
    return new Response(JSON.stringify({ error: 'classroomSlug, owner and repo are required' }), {
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
    attemptedAction: 'list_issues',
  });

  if (!classroom.git_organization) {
    return new Response(
      JSON.stringify({ error: 'No GitHub organization configured for this classroom' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const token = await getInstallationToken(classroom.git_organization);
    const octokit = new Octokit({ auth: token });

    const { data } = await octokit.issues.listForRepo({ owner, repo });

    // Drop pull requests (the issues endpoint includes them) and return only
    // what the form needs.
    const issues = data
      .filter(issue => !issue.pull_request)
      .map(issue => ({ title: issue.title, body: issue.body ?? '' }));

    return new Response(JSON.stringify(issues), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('[api.github-repo-issues] Error fetching issues:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch repository issues' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
