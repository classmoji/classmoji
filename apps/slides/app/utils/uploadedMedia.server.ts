/**
 * uploadedMedia.server.ts — may the browser throw away the document it just
 * put in media for a file slide?
 *
 * The new-slide and replace-file forms upload a large document to media first
 * and then post only its id. When the slide service then refuses it, that
 * object was uploaded for nothing, and it counts against the class's quota
 * until someone finds it on the Media page. The browser deletes it through the
 * gated media route (`DELETE /api/media/:id`) — this only answers whether that
 * is safe: no slide points at it. The server never deletes by a posted id
 * itself, because an id in a form is not proof it is the one just uploaded.
 */

import getPrisma from '@classmoji/database';

/** True when no slide references the media object. False on any doubt. */
export async function mediaUnusedBySlides(mediaId: string): Promise<boolean> {
  try {
    const count = await getPrisma().slide.count({ where: { media_id: mediaId } });
    return count === 0;
  } catch (error: unknown) {
    console.warn('[slides] could not check whether an uploaded document is in use:', error);
    return false;
  }
}
