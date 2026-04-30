import { schedules, logger } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';

/**
 * Daily cleanup of expired notifications. Runs at 03:15 UTC.
 */
export const cleanupExpiredNotifications = schedules.task({
  id: 'cleanup-expired-notifications',
  cron: '15 3 * * *',
  run: async () => {
    const result = await getPrisma().notification.deleteMany({
      where: { expires_at: { lt: new Date() } },
    });
    logger.info('Cleaned up expired notifications', { count: result.count });
    return { count: result.count };
  },
});
