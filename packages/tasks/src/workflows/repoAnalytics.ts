import { task, logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

interface RefreshRepoAnalyticsPayload {
  repositoryAssignmentId: string;
}

interface RefreshRepoAnalyticsForRepoPayload {
  gitRepoId: string;
}

/**
 * Refresh analytics for a single gitRepo assignment.
 *
 * A failure (a missing or unreachable repo) is persisted on the row and not
 * rescheduled: it would never resolve on its own.
 */
export const refreshRepoAnalytics = task({
  id: 'refresh-repo-analytics',
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: RefreshRepoAnalyticsPayload) => {
    const { repositoryAssignmentId } = payload;

    const result = await ClassmojiService.repoAnalytics.refreshOne(repositoryAssignmentId);

    if (result.stale) {
      logger.warn('Repo analytics refresh failed', {
        repositoryAssignmentId,
        error: result.error ?? null,
      });
    }

    return result;
  },
});

/**
 * Cron: refresh analytics for every active gitRepo assignment every 6h.
 *
 * TEMPORARILY DISABLED — the 6h fan-out was churning Trigger runs against
 * stale/fake/deleted repos. A declarative `schedules.task` cron can ONLY be
 * turned off by removing it from code and redeploying packages/tasks (it cannot
 * be toggled in the Trigger.dev dashboard or via the API). To re-enable: restore
 * `schedules` to the import above, uncomment this block, and redeploy.
 * The on-demand `refresh-repo-analytics` task is unaffected.
 */
// export const refreshAllActiveRepoAnalytics = schedules.task({
//   id: 'refresh-repo-analytics-all',
//   cron: '0 */6 * * *',
//   run: async () => {
//     const ids = await ClassmojiService.repoAnalytics.listActiveAssignmentIds();
//
//     logger.info('Refreshing active repo analytics', {
//       count: ids.length,
//       first: ids[0] ?? null,
//       last: ids[ids.length - 1] ?? null,
//     });
//
//     for (const id of ids) {
//       await refreshRepoAnalytics.trigger({ repositoryAssignmentId: id });
//     }
//
//     return { count: ids.length };
//   },
// });

/**
 * Refresh every submission row on one git repo in a single run.
 *
 * This is what a push triggers. The per-row task below is the on-demand path
 * (a TA hitting refresh on one submission, and the backfill script); fanning it
 * out across a repo's rows re-read the same four GitHub endpoints once per row
 * to write N identical snapshots, so a repo carrying N assignments cost N times
 * the GitHub budget for a single push.
 */
export const refreshRepoAnalyticsForRepo = task({
  id: 'refresh-repo-analytics-repo',
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: RefreshRepoAnalyticsForRepoPayload) => {
    const { gitRepoId } = payload;

    const result = await ClassmojiService.repoAnalytics.refreshRepo(gitRepoId);

    if (result.skipped) {
      logger.info('Repo analytics still fresh, skipped the provider read', {
        gitRepoId,
        rows: result.rows,
      });
      return result;
    }

    if (result.stale) {
      logger.warn('Repo analytics refresh failed', {
        gitRepoId,
        rows: result.rows,
        error: result.error ?? null,
      });
    }

    return result;
  },
});
