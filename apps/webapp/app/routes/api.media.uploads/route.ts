import { ClassmojiService } from '@classmoji/services';
import {
  mediaError,
  mediaErrorResponse,
  readJsonBody,
  requireMediaAccess,
  requireMethod,
} from '~/utils/mediaApi.server';
import type { Route } from './+types/route';

/**
 * `POST /api/media/uploads` — open a multipart upload.
 *
 * Thin over `ClassmojiService.media.createUpload`: this route decides who is
 * asking and what shape the body is, and nothing else. Every refusal that has
 * anything to do with media — the deployment having no bucket, the classroom
 * not being Pro, the file being too big or the wrong kind, the quota being
 * full — is the service's, so the same answer comes back whichever surface
 * asked (this route today, slides and pages in P3).
 *
 * The response carries `contentType` because the browser puts it on each part
 * PUT; it is the type the SERVER assigned from the extension, never the one the
 * file picker guessed.
 */
export const action = async ({ request }: Route.ActionArgs) => {
  try {
    requireMethod(request, 'POST');

    const body = await readJsonBody(request);
    const classroomId = typeof body.classroomId === 'string' ? body.classroomId : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN;

    if (!classroomId || !filename) {
      return mediaError('BAD_REQUEST', 400, { message: 'classroomId and filename are required.' });
    }

    // A body with no size, or one carrying NaN/Infinity, is a MALFORMED
    // request, not a file that is too large — and 413 is what the upload client
    // shows the uploader as "your file is over the limit". Refusing it here
    // keeps the service's FILE_TOO_LARGE meaning one thing.
    if (!Number.isFinite(sizeBytes)) {
      return mediaError('BAD_REQUEST', 400, { message: 'sizeBytes must be a number of bytes.' });
    }

    const { userId, classroom } = await requireMediaAccess(request, classroomId, 'create_upload');

    const options =
      body.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? (body.options as { optimise?: boolean; keepOriginal?: boolean; allowDownload?: boolean })
        : {};

    const created = await ClassmojiService.media.createUpload({
      classroom,
      userId,
      filename,
      sizeBytes,
      options,
    });

    return Response.json(created);
  } catch (error) {
    return mediaErrorResponse(error);
  }
};
