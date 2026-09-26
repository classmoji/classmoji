import { logger, task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { getGitProvider, type GitLabProvider } from '@classmoji/services';

/**
 * Move GitLab content projects (pages and slides) from the top group into
 * their classroom's subgroup, where content projects now live, next to the
 * class's student projects. One-time and idempotent: a project already in its
 * subgroup, or missing at the old path, is skipped. GitLab keeps redirects
 * from the old path, and the project keeps its hooks and history.
 */
export async function moveGitlabContentProjects(): Promise<{
  moved: number;
  skipped: number;
  failed: number;
}> {
  const result = { moved: 0, skipped: 0, failed: 0 };
  const classrooms = await getPrisma().classroom.findMany({
    where: { git_namespace: { not: null }, git_organization: { provider: 'GITLAB' } },
    select: { slug: true, git_namespace: true, content_repo: true, git_organization: true },
  });
  for (const classroom of classrooms) {
    const namespace = classroom.git_namespace as string;
    const group = classroom.git_organization.login;
    const repo = classroom.content_repo;
    if (!repo || !group || group === namespace) {
      result.skipped += 1;
      continue;
    }
    try {
      const provider = getGitProvider(classroom.git_organization) as GitLabProvider;
      if (await provider.projectExists(namespace, repo)) {
        result.skipped += 1;
        continue;
      }
      if (!(await provider.projectExists(group, repo))) {
        result.skipped += 1;
        continue;
      }
      await provider.transferProject(group, repo, namespace);
      result.moved += 1;
      logger.info('Moved content project into its class subgroup', {
        classroom: classroom.slug,
        from: `${group}/${repo}`,
        to: `${namespace}/${repo}`,
      });
    } catch (error: unknown) {
      result.failed += 1;
      logger.warn('Could not move content project', {
        classroom: classroom.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('Gitlab content project move done', result);
  return result;
}

export const moveGitlabContentProjectsTask = task({
  id: 'gitlab-move-content-projects',
  run: async () => moveGitlabContentProjects(),
});
