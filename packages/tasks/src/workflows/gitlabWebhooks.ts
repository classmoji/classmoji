import { logger, schedules, task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider, type GitLabProvider } from '@classmoji/services';
import {
  extendedDeadlineMs,
  GITLAB_PROJECTS_SUBGROUP,
  type ExtensionTransaction,
} from '@classmoji/utils';

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
  if (!url || !process.env.GITLAB_WEBHOOK_SECRET) {
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
          ClassmojiService.gitlabInstance.webhookSecret(
            classroom.git_organization.gitlab_instance_id
          ) as string
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
 * "Active": a published REPO-mode assignment whose deadline, pushed out by the
 * extension hours the student bought (net of refunds), is not more than two
 * days past (late pushes still count; long-closed ones don't need polling).
 */
const POLL_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
/** How far back a deadline can be and still be extended into the poll window. */
const POLL_EXTENSION_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_MAX_REPOS = 500;

const ACTIVE_ASSIGNMENT = {
  type: 'REPO',
  submission_mode: 'REPO',
  is_published: true,
} as const;

/**
 * Whether one submission row still needs its repo polled: no deadline, or the
 * deadline plus the row's net purchased hours plus the grace period is still
 * ahead. Exported for tests.
 */
export function isPollWindowOpen(
  deadline: Date | string | null | undefined,
  transactions: ExtensionTransaction[] | null | undefined,
  now: number = Date.now()
): boolean {
  if (!deadline) return true;
  const cutoff = extendedDeadlineMs(deadline, transactions);
  return cutoff === null || cutoff + POLL_GRACE_MS > now;
}

export async function pollGitlabPushes(): Promise<{
  repos: number;
  recorded: number;
  failed: number;
}> {
  const result = { repos: 0, recorded: 0, failed: 0 };
  const now = Date.now();
  const since = new Date(now - POLL_GRACE_MS);
  const horizon = new Date(now - POLL_EXTENSION_HORIZON_MS);
  // A Prisma filter cannot sum a row's purchased hours, so the query keeps
  // every row that MIGHT be open (plain deadline in the window, or any
  // purchase on a deadline in the last 30 days) and `isPollWindowOpen` makes
  // the exact call below.
  const rowFilter = {
    assignment: ACTIVE_ASSIGNMENT,
    OR: [
      { assignment: { student_deadline: null } },
      { assignment: { student_deadline: { gt: since } } },
      {
        assignment: { student_deadline: { gt: horizon } },
        token_transactions: { some: { type: 'PURCHASE' as const } },
      },
    ],
  };
  const candidates = await getPrisma().gitRepo.findMany({
    where: {
      provider: 'GITLAB',
      classroom: { is_archived: false, git_namespace: { not: null } },
      assignments: { some: rowFilter },
    },
    take: POLL_MAX_REPOS,
    // Least recently polled first, so every active repo gets its turn however
    // many there are (ordering by last push would starve a repo that was
    // just pushed to, exactly the one whose webhook may have broken since).
    orderBy: [{ push_polled_at: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      last_push_at: true,
      assignments: {
        where: rowFilter,
        select: {
          assignment: { select: { student_deadline: true } },
          // Every row, refunds included: a REFUND carries negative hours.
          token_transactions: { select: { hours_purchased: true } },
        },
      },
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
  const repos = candidates.filter(repo =>
    repo.assignments.some(row =>
      isPollWindowOpen(row.assignment.student_deadline, row.token_transactions, now)
    )
  );
  // A repo the pre-filter kept but whose extension has run out still had its
  // turn: send it to the back of the queue so it cannot hold a slot forever.
  const closed = candidates.filter(repo => !repos.includes(repo)).map(repo => repo.id);
  if (closed.length > 0) {
    await getPrisma()
      .gitRepo.updateMany({ where: { id: { in: closed } }, data: { push_polled_at: new Date() } })
      .catch(() => {});
  }

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
    // Its turn is over either way: it goes to the back of the queue.
    await getPrisma()
      .gitRepo.update({ where: { id: repo.id }, data: { push_polled_at: new Date() } })
      .catch(() => {});
  }
  logger.info('Gitlab push poll done', result);
  return result;
}

/**
 * Every 30 minutes: the fallback for GitLabs whose webhooks can't reach us. A push is
 * recorded at Gitlab's own push time, so the interval only delays when it
 * shows up, never whether it was on time.
 */
export const pollGitlabPushesTask = schedules.task({
  id: 'gitlab-poll-pushes',
  cron: '*/30 * * * *',
  run: async () => pollGitlabPushes(),
});
