import { schedules, logger } from '@trigger.dev/sdk';
import { deleteAbandonedExampleClassrooms } from '@classmoji/services';

/**
 * Delete "Example Course" sandboxes three days after they were made, used or
 * not (`deleteAbandonedExampleClassrooms`). They are created on demand when
 * someone starts the tour, and re-provisioning is idempotent, so a deleted
 * sandbox simply comes back the next time its owner clicks "Take a tour".
 *
 * 06:15 UTC daily, after the content sweeps (05:25, 05:45) and the instructor
 * contacts job (05:50) so the morning batch stays in one window.
 */
const CLEANUP_CRON = '15 6 * * *';

export const exampleClassroomCleanupTask = schedules.task({
  id: 'example-classroom-cleanup',
  // Runs again on its schedule, and that next run is the retry.
  retry: { maxAttempts: 1 },
  cron: CLEANUP_CRON,
  run: async () => {
    const report = await deleteAbandonedExampleClassrooms();
    logger.info('Cleaned up abandoned example classrooms', { ...report });
    return report;
  },
});
