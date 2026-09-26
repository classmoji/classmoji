import { ClassmojiService } from '@classmoji/services';
import {
  mediaErrorResponse,
  requireMediaAccessForObject,
  requireMediaId,
  requireMethod,
} from '~/utils/mediaApi.server';
import type { Route } from './+types/route';

/**
 * `DELETE /api/media/:mediaId` — remove a media object.
 *
 * A deliberate delete: the media page's Delete button. It aborts an open
 * multipart and removes the objects of a finished one, so either way the
 * classroom stops paying for it. The upload client does NOT call this when an
 * upload fails — it calls `POST /api/media/uploads/:mediaId/abort`, which
 * leaves a finished file alone — because a failure the browser saw may be a
 * `complete` that succeeded and whose answer was lost.
 *
 * 204 on success, including a repeat call on an object already deleted: the
 * service re-attempts the object deletes, so a delete that half-failed can be
 * retried. 404 for an id that was never issued.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  try {
    requireMethod(request, 'DELETE');

    const mediaId = requireMediaId(params.mediaId);
    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'delete_media');

    await ClassmojiService.media.deleteMedia({ classroom, mediaId });

    return new Response(null, { status: 204 });
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
