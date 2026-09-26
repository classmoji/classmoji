/**
 * GitHub Repos API - Lists repositories in a classroom's GitHub organization
 *
 * Two modes (both authenticated with the org installation token, so private org
 * repos are visible without exposing the token to the browser):
 *  - No `q`: lists the org's repos (most recently updated). Used by the
 *    code-aware quiz preview repo picker.
 *  - With `q`: template search. Merges global public results with the
 *    classroom org's repos (public + private) so instructors can pick a private
 *    template that lives in their org, while still finding public templates
 *    hosted anywhere. Used by the assignment template picker.
 *
 * Only OWNER and ASSISTANT roles can access this endpoint.
 */
import { Octokit } from '@octokit/rest';
import getPrisma from '@classmoji/database';
import { GitLabProvider, getGitProvider } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { getInstallationToken } from '~/routes/student.$class.quizzes/helpers.server';
import type { Route } from './+types/route';

const SEARCH_LIMIT = 50;

interface RepoSearchItem {
  name: string;
  full_name: string;
  description: string | null;
  updated_at: string | null | undefined;
  private: boolean;
  language: string | null;
  stargazers_count: number;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const classroomSlug = url.searchParams.get('classroomSlug');
  const query = url.searchParams.get('q')?.trim() ?? '';

  if (!classroomSlug) {
    return new Response(JSON.stringify({ error: 'classroomSlug is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify the caller is on the teaching team. This backs the repo picker on
  // the quiz detail page, so it carries the same roles as the quiz routes.
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'GITHUB_REPOS',
    attemptedAction: 'list',
  });

  // Check if classroom has a git organization configured
  if (!classroom.git_organization) {
    return new Response(
      JSON.stringify({ error: 'No git organization configured for this classroom' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const gitOrg = classroom.git_organization;

    if (gitOrg.provider === 'GITLAB') {
      const repoList = await listGitLabTemplates(gitOrg, query);
      return new Response(JSON.stringify(repoList), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const token = await getInstallationToken(gitOrg);
    const octokit = new Octokit({ auth: token });

    // Template search mode: merge global public results with the org's repos
    // (which include private). Returns a richer shape so the picker can badge
    // private repos.
    if (query.length >= 2) {
      // Exclude repos Classmoji generated as student/team repos (across every
      // classroom in this org) so they don't pollute the template picker.
      const generated = await getPrisma().gitRepo.findMany({
        where: { classroom: { git_org_id: gitOrg.id } },
        select: { name: true },
      });
      const excluded = new Set(generated.map(r => `${gitOrg.login}/${r.name}`.toLowerCase()));

      const repoList = await searchTemplateRepos(octokit, query, gitOrg.login, excluded);
      return new Response(JSON.stringify(repoList), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

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
  } catch (error: unknown) {
    console.error('[api.github-repos] Error fetching repos:', error);
    const reposWord =
      classroom.git_organization.provider === 'GITLAB' ? 'projects' : 'repositories';
    return new Response(JSON.stringify({ error: `Failed to fetch ${reposWord}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GitLab: projects anywhere in the classroom's group (subgroups included),
 * with the `templates` subgroup first and the student projects Classmoji
 * created (in any classroom of this group) left out. GitLab has no "template"
 * flag on the free plan, so the dedicated subgroup stands in for it.
 */
async function listGitLabTemplates(
  gitOrg: Parameters<typeof getGitProvider>[0] & { id: string; login: string },
  query: string
): Promise<RepoSearchItem[]> {
  const provider = getGitProvider(gitOrg) as GitLabProvider;
  const [projects, generated] = await Promise.all([
    provider.listGroupProjects(gitOrg.login, query.length >= 2 ? query : ''),
    getPrisma().gitRepo.findMany({
      where: { classroom: { git_org_id: gitOrg.id } },
      select: { name: true, classroom: { select: { git_namespace: true } } },
    }),
  ]);
  const excluded = new Set(
    generated.map(r => `${r.classroom.git_namespace ?? gitOrg.login}/${r.name}`.toLowerCase())
  );
  const templatesPrefix = `${gitOrg.login}/templates/`.toLowerCase();

  return projects
    .filter(p => !excluded.has(p.path_with_namespace.toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.path_with_namespace.toLowerCase().startsWith(templatesPrefix)) -
        Number(a.path_with_namespace.toLowerCase().startsWith(templatesPrefix))
    )
    .slice(0, SEARCH_LIMIT)
    .map(p => ({
      name: p.name,
      full_name: p.path_with_namespace,
      description: p.description,
      updated_at: p.last_activity_at,
      private: p.visibility !== 'public',
      language: null,
      stargazers_count: p.star_count ?? 0,
    }));
}

/**
 * Run two name searches and merge them: any public repo on GitHub, plus repos
 * in the classroom org (public + private, visible to the installation token).
 * Deduped by full_name (the org's public repos match both queries). Repos in
 * `excluded` (Classmoji-generated student/team repos) are filtered out.
 */
async function searchTemplateRepos(
  octokit: Octokit,
  query: string,
  orgLogin: string,
  excluded: Set<string>
): Promise<RepoSearchItem[]> {
  const [publicResult, orgResult] = await Promise.allSettled([
    octokit.rest.search.repos({
      q: `${query} in:name is:public`,
      sort: 'updated',
      order: 'desc',
      per_page: SEARCH_LIMIT,
    }),
    octokit.rest.search.repos({
      q: `${query} in:name org:${orgLogin}`,
      sort: 'updated',
      order: 'desc',
      per_page: SEARCH_LIMIT,
    }),
  ]);

  const merged = new Map<string, RepoSearchItem>();

  // Org results first so private repos win the dedupe and surface at the top.
  for (const result of [orgResult, publicResult]) {
    if (result.status !== 'fulfilled') {
      console.error('[api.github-repos] Template search query failed:', result.reason);
      continue;
    }
    for (const r of result.value.data.items) {
      if (merged.has(r.full_name)) continue;
      if (excluded.has(r.full_name.toLowerCase())) continue;
      merged.set(r.full_name, {
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        updated_at: r.updated_at,
        private: r.private,
        language: r.language ?? null,
        stargazers_count: r.stargazers_count ?? 0,
      });
    }
  }

  return Array.from(merged.values()).slice(0, SEARCH_LIMIT);
}
