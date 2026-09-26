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
 * `POST /api/media/uploads/:mediaId/complete` — assemble and verify.
 *
 * The parts are `{ partNumber, etag }` with the etag exactly as the browser
 * read it from R2's `ETag` response header, quotes and all. The service puts
 * them in ascending order (S3 insists, and a client that collected them as they
 * finished has completion order instead) and checks the assembled object's real
 * size against the one the quota was reserved against.
 *
 * A size mismatch comes back 409 `SIZE_MISMATCH` with the object already
 * deleted — there is nothing for the client to retry, and nothing left behind.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    const body = await readJsonBody(request);
    const parts = Array.isArray(body.parts)
      ? body.parts
          .filter(
            (part): part is { partNumber: number; etag: string } =>
              Boolean(part) &&
              typeof part === 'object' &&
              typeof (part as { partNumber?: unknown }).partNumber === 'number' &&
              typeof (part as { etag?: unknown }).etag === 'string'
          )
          .map(part => ({ partNumber: part.partNumber, etag: part.etag }))
      : null;

    if (!parts || parts.length === 0) {
      return mediaError('BAD_REQUEST', 400, {
        message: 'parts must be a non-empty array of { partNumber, etag }.',
      });
    }

    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'complete_upload');

    const completed = await ClassmojiService.media.completeUpload({ classroom, mediaId, parts });

    return Response.json(completed);
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
