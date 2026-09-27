/**
 * uploadCapability.server.ts — the upload capability a slides screen hands its
 * client, or null when it cannot be worked out.
 *
 * `uploadCapabilityFor` reads the Pro state, media usage and the classroom's
 * delivery setup, and any of those reads can fail. Null is safe rather than
 * silent: the client then routes a file the way it did before routing existed
 * — to the course repository, within its cap — and every server upload entry
 * asks the router again from the file it receives, so a file that belongs in
 * media is still redirected there (`USE_MEDIA`). A lookup failure must not take
 * the editor or the upload form down with it. Same shape as the pages editor's
 * `loadUploadCapability`.
 */

import { ClassmojiService } from '@classmoji/services';
import type { UploadCapability } from '@classmoji/services/media/router';

type CapabilityClassroom = Parameters<typeof ClassmojiService.media.uploadCapabilityFor>[0];

export async function loadUploadCapability(
  classroom: CapabilityClassroom,
  surface: string
): Promise<UploadCapability | null> {
  try {
    return await ClassmojiService.media.uploadCapabilityFor(classroom);
  } catch (error: unknown) {
    console.warn(`[slides] upload capability unavailable (${surface}):`, error);
    return null;
  }
}
