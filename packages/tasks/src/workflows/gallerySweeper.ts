import { logger, schedules } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * Removes students' project-gallery uploads that no response uses any more:
 * replaced covers, abandoned drafts, and the uploads of a deleted form. Without
 * it they count against the classroom's media quota for good, and a student
 * has no way to delete their own. See `findUnusedGalleryUploads` for what
 * counts as used. A delete is the ordinary media delete (tombstone, then the
 * R2 objects). Daily; the next run picks up what this one left.
 */
export const galleryUploadSweeper = schedules.task({
  id: 'gallery-upload-sweeper',
  retry: { maxAttempts: 1 },
  cron: '50 4 * * *',
  run: async () => {
    const unused = await ClassmojiService.gallery.findUnusedGalleryUploads();
    let removed = 0;
    for (const row of unused) {
      try {
        await ClassmojiService.media.deleteMedia({
          classroom: { id: row.classroom_id },
          mediaId: row.id,
        });
        removed += 1;
      } catch (error) {
        logger.warn('Could not remove an unused gallery upload', { mediaId: row.id, error });
      }
    }
    return { found: unused.length, removed };
  },
});
