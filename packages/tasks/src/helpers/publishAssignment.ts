import { logger } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/** Prisma's "no record was found for an update" (P2025), matched by code. */
export const isRecordNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025';

/**
 * Marks an assignment published once it is out on student repos. An
 * assignment deleted while the run was queued (a teacher deleting it right
 * after publishing, to redo it) has nothing left to publish: the repos and
 * access are done, so the run ends cleanly instead of failing on the update.
 */
export const publishAssignment = async (assignmentId: string): Promise<void> => {
  try {
    await ClassmojiService.assignment.update(assignmentId, { is_published: true });
  } catch (error: unknown) {
    if (!isRecordNotFound(error)) throw error;
    logger.warn('Assignment deleted before it could be marked published; skipping', {
      assignmentId,
    });
  }
};
