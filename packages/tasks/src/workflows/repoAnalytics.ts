import { task, schedules, logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

interface RefreshRepoAnalyticsPayload {
  repositoryAssignmentId: string;
}

/**
 * Refresh analytics for a single repository assignment.
 *
 * If the snapshot comes back stale (e.g. GitHub contributor-stats cache is
 * still warming and returned 202), self-reschedule in 60s so the row
 * eventually fills in without manual intervention.
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
      logger.info('Repo analytics still stale, rescheduling in 60s', {
        repositoryAssignmentId,
        error: result.error,
      });

      await refreshRepoAnalytics.trigger({ repositoryAssignmentId }, { delay: '60s' });
    }

    return result;
  },
});

/**
 * Cron: refresh analytics for every active repository assignment every 6h.
 */
export const refreshAllActiveRepoAnalytics = schedules.task({
  id: 'refresh-repo-analytics-all',
  cron: '0 */6 * * *',
  run: async () => {
    const ids = await ClassmojiService.repoAnalytics.listActiveAssignmentIds();

    logger.info('Refreshing active repo analytics', {
      count: ids.length,
      first: ids[0] ?? null,
      last: ids[ids.length - 1] ?? null,
    });

    for (const id of ids) {
      await refreshRepoAnalytics.trigger({ repositoryAssignmentId: id });
    }

    return { count: ids.length };
  },
});
