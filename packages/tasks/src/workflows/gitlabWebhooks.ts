import { logger, schedules, task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider, type GitLabProvider } from '@classmoji/services';
import { GITLAB_PROJECTS_SUBGROUP } from '@classmoji/utils';

/**
 * Repair GitLab webhooks: make every student project and content project of a
 * GitLab classroom carry exactly one working Classmoji hook.
 *
 * Hooks break silently, and a broken hook means pushes and issue closes stop
 * counting as submissions: GitLab wipes a hook's secret token when its URL
 * changes, a moved hook-station or rotated relay leaves hooks on an old URL,
 * and GitLab disables a hook after repeated failed deliveries.
 * `ensureProjectPushHook` fixes all of those; this runs it across classrooms.
 */

interface RepairResult {
  classrooms: number;
  projects: number;
  created: number;
  updated: number;
  failed: number;
}

async function repairClassrooms(classroomIds?: string[]): Promise<RepairResult> {
  const result: RepairResult = { classrooms: 0, projects: 0, created: 0, updated: 0, failed: 0 };
  const url = ClassmojiService.gitlabInstance.webhookUrl();
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (!url || !secret) {
    logger.warn('GITLAB_WEBHOOK_URL/SECRET not set: nothing to repair');
    return result;
  }

  const classrooms = await getPrisma().classroom.findMany({
    where: {
      ...(classroomIds ? { id: { in: classroomIds } } : {}),
      is_archived: false,
      git_namespace: { not: null },
      git_organization: { provider: 'GITLAB' },
    },
    select: {
      id: true,
      slug: true,
      git_namespace: true,
      content_repo: true,
      git_organization: true,
      git_repos: { where: { provider: 'GITLAB' }, select: { name: true } },
    },
  });

  for (const classroom of classrooms) {
    result.classrooms += 1;
    let provider: GitLabProvider;
    try {
      provider = getGitProvider(classroom.git_organization) as GitLabProvider;
    } catch (error: unknown) {
      logger.warn('No usable Gitlab connection for classroom', {
        classroom: classroom.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      result.failed += classroom.git_repos.length;
      continue;
    }

    // Student and team projects live in the class subgroup's `projects`, the
    // content project at the class subgroup's root.
    const targets = classroom.git_repos.map(repo => ({
      group: `${classroom.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`,
      project: repo.name,
    }));
    if (classroom.content_repo) {
      targets.push({ group: classroom.git_namespace as string, project: classroom.content_repo });
    }

    for (const target of targets) {
      result.projects += 1;
      try {
        const outcome = await provider.ensureProjectPushHook(
          target.group,
          target.project,
          url,
          secret
        );
        result[outcome] += 1;
      } catch (error: unknown) {
        result.failed += 1;
        logger.warn('Could not repair the Gitlab webhook', {
          classroom: classroom.slug,
          project: `${target.group}/${target.project}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info('Gitlab webhook repair done', { ...result });
  return result;
}

/** One classroom, on demand (the classroom settings button). */
export const repairGitlabWebhooksTask = task({
  id: 'gitlab-repair-webhooks',
  queue: { concurrencyLimit: 2 },
  run: async (payload: { classroomId: string }) => repairClassrooms([payload.classroomId]),
});

/** Every active GitLab classroom, nightly. */
export const repairGitlabWebhooksNightly = schedules.task({
  id: 'gitlab-repair-webhooks-nightly',
  cron: '40 4 * * *',
  run: async () => repairClassrooms(),
});

/**
 * Catch up on GitLab pushes whose webhook never arrived: a school GitLab that
 * can't reach hook-station, a hook GitLab disabled, a delivery lost in
 * transit. Reads each active student project's push events (GitLab's
 * server-side times) since the last push Classmoji recorded, and records them
 * the way the webhook would have. Harmless when webhooks work: a push already
 * recorded is not newer than `last_push_at`, so it is skipped.
 *
 * "Active": a published REPO-mode assignment whose deadline is not more than
 * two days past (late pushes still count; long-closed ones don't need polling).
 */
const POLL_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
const POLL_MAX_REPOS = 500;

export async function pollGitlabPushes(): Promise<{
  repos: number;
  recorded: number;
  failed: number;
}> {
  const result = { repos: 0, recorded: 0, failed: 0 };
  const since = new Date(Date.now() - POLL_GRACE_MS);
  const repos = await getPrisma().gitRepo.findMany({
    where: {
      provider: 'GITLAB',
      classroom: { is_archived: false, git_namespace: { not: null } },
      assignments: {
        some: {
          assignment: {
            type: 'REPO',
            submission_mode: 'REPO',
            is_published: true,
            OR: [{ student_deadline: null }, { student_deadline: { gt: since } }],
          },
        },
      },
    },
    take: POLL_MAX_REPOS,
    orderBy: { last_push_at: { sort: 'asc', nulls: 'first' } },
    select: {
      id: true,
      name: true,
      last_push_at: true,
      classroom: {
        select: {
          git_namespace: true,
          git_organization: {
            include: { gitlab_connection: { select: { gitlab_username: true } } },
          },
        },
      },
    },
  });

  for (const repo of repos) {
    const org = repo.classroom?.git_organization;
    const namespace = repo.classroom?.git_namespace
      ? `${repo.classroom.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`
      : null;
    if (!org || !namespace) continue;
    result.repos += 1;
    try {
      const provider = getGitProvider(org) as GitLabProvider;
      const pushes = await provider.listDefaultBranchPushes(
        namespace,
        repo.name,
        repo.last_push_at
      );
      // Classmoji pushes the template as the instructor's connection; those
      // are setup, never a student's submission.
      const setupUser = org.gitlab_connection?.gitlab_username ?? null;
      for (const push of pushes) {
        if (setupUser && push.author === setupUser) continue;
        await ClassmojiService.gitRepo.recordPushTime(repo.id, push.at);
        await ClassmojiService.gitRepoAssignment.recordPush(repo.id, push.at);
        result.recorded += 1;
      }
    } catch (error: unknown) {
      result.failed += 1;
      logger.warn('Could not poll Gitlab pushes', {
        repo: `${namespace}/${repo.name}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('Gitlab push poll done', result);
  return result;
}

/** Every 15 minutes: the fallback for GitLabs whose webhooks can't reach us. */
export const pollGitlabPushesTask = schedules.task({
  id: 'gitlab-poll-pushes',
  cron: '*/15 * * * *',
  run: async () => pollGitlabPushes(),
});
