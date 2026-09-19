import { ClassmojiService } from '@classmoji/services';
import {
  mediaError,
  mediaErrorResponse,
  readJsonBody,
  requireMediaAccessForObject,
  requireMediaId,
  requireMethod,
} from '~/utils/mediaApi.server';
import type { Route } from './+types/route';

/**
 * `POST /api/media/uploads/:mediaId/parts` — presigned URLs for a batch of parts.
 *
 * Called repeatedly during one upload, which is why it takes a BATCH rather
 * than all of a file's part numbers: the client asks for the next few, uses
 * them inside their fifteen minutes, and comes back. The service caps how many
 * one call will mint.
 *
 * Addressed by media id alone — by this point the client holds nothing else —
 * so the classroom is read off the row and the gate is applied to that. See
 * `requireMediaAccessForObject`.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    const body = await readJsonBody(request);
    const partNumbers = Array.isArray(body.partNumbers)
      ? body.partNumbers.filter((n): n is number => typeof n === 'number')
      : null;

    if (!partNumbers || partNumbers.length === 0) {
      return mediaError('BAD_REQUEST', 400, { message: 'partNumbers must be a non-empty array.' });
    }

    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'sign_upload_parts');

    const signed = await ClassmojiService.media.signParts({ classroom, mediaId, partNumbers });

    return Response.json(signed);
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
