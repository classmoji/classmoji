import { logger, metadata } from '@trigger.dev/sdk';

/**
 * What a unit of work (one student repository) is doing right now, for the
 * instructor's operation banner.
 *
 * Kept on the run's own metadata as `current`. The banner already subscribes
 * to every run carrying the session tag, and metadata arrives with the run, so
 * no extra plumbing is needed on the way to the browser.
 *
 * Best-effort: the status line is decoration, it never fails the work.
 */
export const reportStatus = async (current: string) => {
  try {
    metadata.set('current', current);
    await metadata.flush();
  } catch (error: unknown) {
    logger.warn('Could not report status', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Why a unit of work failed, in a word the instructor's panel can group by
 * and say plainly. Set just before the run throws; a later attempt that
 * succeeds makes it moot, since the panel reads it only from failed runs.
 */
export type FailureReason =
  | 'permission_denied'
  | 'template_not_found'
  | 'github_unreachable'
  | 'repository_deleted';

export const reportFailureReason = async (reason: FailureReason) => {
  try {
    metadata.set('reason', reason);
    await metadata.flush();
  } catch (error: unknown) {
    logger.warn('Could not report failure reason', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
