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
 * One endpoint for two situations, because the caller does not always know
 * which it is in: the upload client fires this best-effort after ANY failure,
 * and whether the multipart was still open or the object had just been
 * completed depends on where it failed. `deleteMedia` aborts an open multipart
 * and deletes the objects of a finished one, so either way the classroom stops
 * paying for it.
 *
 * 204 on success, and 404 for an id that is already gone — the client ignores
 * both, which is what "best effort" means. Nothing here throws past the
 * handler; a repeat call is a 404, never a 500.
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
