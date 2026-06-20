import { task, logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

interface RefreshRepoAnalyticsPayload {
  repositoryAssignmentId: string;
  /** Number of times this run has already self-rescheduled (loop guard). */
  attempt?: number;
}

/**
 * Cap on self-reschedules for the transient "still warming" case. GitHub's
 * contributor-stats cache normally warms within a couple of minutes, so ~10
 * minutes of 60s retries is plenty. This bound exists because an uncapped
 * self-reschedule previously turned every permanently-stale assignment (e.g. a
 * deleted or fake/test repo) into a forever 1-per-minute loop, producing
 * hundreds of thousands of runs.
 */
const MAX_PENDING_RESCHEDULES = 10;

/**
 * Refresh analytics for a single gitRepo assignment.
 *
 * Only self-reschedules for a *transient* pending state (GitHub contributor-stats
 * returned 202 while warming its cache) — never for a hard error such as a
 * missing/unreachable repo, which would never resolve — and only up to
 * MAX_PENDING_RESCHEDULES times, so a stuck assignment can't loop indefinitely.
 */
export const refreshRepoAnalytics = task({
  id: 'refresh-repo-analytics',
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: RefreshRepoAnalyticsPayload) => {
    const { repositoryAssignmentId, attempt = 0 } = payload;

    const result = await ClassmojiService.repoAnalytics.refreshOne(repositoryAssignmentId);

    // `stale` covers both a transient 202 (no error) and a persisted hard error.
    // Reschedule only for the transient case, and only within the retry budget.
    const transientlyPending = result.stale && !result.error;

    if (transientlyPending && attempt < MAX_PENDING_RESCHEDULES) {
      logger.info('Repo analytics still warming, rescheduling in 60s', {
        repositoryAssignmentId,
        attempt: attempt + 1,
      });
      await refreshRepoAnalytics.trigger(
        { repositoryAssignmentId, attempt: attempt + 1 },
        { delay: '60s' }
      );
    } else if (result.stale) {
      logger.warn('Repo analytics still stale; not rescheduling', {
        repositoryAssignmentId,
        attempt,
        gaveUp: transientlyPending,
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
