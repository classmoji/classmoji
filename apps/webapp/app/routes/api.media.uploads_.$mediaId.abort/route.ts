import { ClassmojiService } from '@classmoji/services';
import {
  mediaErrorResponse,
  requireMediaAccessForObject,
  requireMediaId,
  requireMethod,
} from '~/utils/mediaApi.server';
import type { Route } from './+types/route';

/**
 * `POST /api/media/uploads/:mediaId/abort` — cancel an upload that is still open.
 *
 * The upload client's cleanup after any failure, and the only thing it calls
 * there. It acts on an UPLOADING row alone and is a no-op for anything else,
 * which is the point: the browser cannot always tell a failed upload from one
 * whose `complete` succeeded and whose answer was lost on the way back, and a
 * cleanup that could delete a finished file would turn that lost answer into a
 * lost file. Deleting a file is `DELETE /api/media/:mediaId`, a separate
 * decision somebody makes on purpose.
 *
 * 204 whether or not there was anything to cancel. 404 for an id that is not
 * one, or one in a classroom the caller cannot edit — the same masking as the
 * other id-addressed routes (`requireMediaAccessForObject`). No body is read.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'abort_upload');

    await ClassmojiService.media.abortUpload({ classroom, mediaId });

    return new Response(null, { status: 204 });
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
