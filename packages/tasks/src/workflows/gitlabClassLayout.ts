import { logger, task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { getGitProvider, type GitLabProvider } from '@classmoji/services';
import { GITLAB_PROJECTS_SUBGROUP } from '@classmoji/utils';

/**
 * Bring existing GitLab classrooms to the class subgroup layout:
 *
 *   <class subgroup>/<content_repo>   the content project, displayed "Content"
 *   <class subgroup>/projects/...     student and team projects
 *   <class subgroup>/teams/...        team subgroups (already there)
 *
 * Content projects move in from the top group, student and team projects
 * from the class subgroup's root into `projects`. Idempotent: a project
 * already in place is left alone (the content one is only renamed), one
 * missing at both paths is skipped. GitLab keeps redirects from old paths, and
 * projects keep their hooks, history and members.
 */
interface LayoutResult {
  moved: number;
  skipped: number;
  failed: number;
}

async function moveInto(
  provider: GitLabProvider,
  from: string,
  to: string,
  project: string,
  result: LayoutResult,
  classroom: string
): Promise<boolean> {
  try {
    if (await provider.projectExists(to, project)) {
      result.skipped += 1;
      return true;
    }
    if (!(await provider.projectExists(from, project))) {
      result.skipped += 1;
      return false;
    }
    await provider.transferProject(from, project, to);
    result.moved += 1;
    logger.info('Moved Gitlab project', { classroom, from: `${from}/${project}`, to });
    return true;
  } catch (error: unknown) {
    result.failed += 1;
    logger.warn('Could not move Gitlab project', {
      classroom,
      project: `${from}/${project}`,
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function organizeGitlabClasses(): Promise<LayoutResult> {
  const result: LayoutResult = { moved: 0, skipped: 0, failed: 0 };
  const classrooms = await getPrisma().classroom.findMany({
    where: { git_namespace: { not: null }, git_organization: { provider: 'GITLAB' } },
    select: {
      slug: true,
      git_namespace: true,
      content_repo: true,
      git_organization: true,
      git_repos: { where: { provider: 'GITLAB' }, select: { name: true } },
    },
  });

  for (const classroom of classrooms) {
    const namespace = classroom.git_namespace as string;
    const group = classroom.git_organization.login;
    let provider: GitLabProvider;
    try {
      provider = getGitProvider(classroom.git_organization) as GitLabProvider;
    } catch (error: unknown) {
      result.failed += 1;
      logger.warn('No usable Gitlab connection for classroom', {
        classroom: classroom.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const repo = classroom.content_repo;
    if (repo && group && group !== namespace) {
      if (await moveInto(provider, group, namespace, repo, result, classroom.slug)) {
        try {
          await provider.setProjectDisplayName(namespace, repo, 'Content');
        } catch (error: unknown) {
          logger.warn('Could not rename the content project', {
            classroom: classroom.slug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (classroom.git_repos.length) {
      const projects = `${namespace}/${GITLAB_PROJECTS_SUBGROUP}`;
      try {
        await provider.resolveOrCreateGroupId(projects);
      } catch (error: unknown) {
        result.failed += classroom.git_repos.length;
        logger.warn('Could not create the projects subgroup', {
          classroom: classroom.slug,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const { name } of classroom.git_repos) {
        await moveInto(provider, namespace, projects, name, result, classroom.slug);
      }
    }
  }

  logger.info('Gitlab class layout done', { ...result });
  return result;
}

export const organizeGitlabClassesTask = task({
  id: 'gitlab-organize-classes',
  run: async () => organizeGitlabClasses(),
});
