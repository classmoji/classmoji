import { REPO_REST_MAX_BYTES, repoFileTooLargeMessage } from '@classmoji/utils/repo-limits';
import {
  UploadTooLargeError,
  readLimitedFormData,
  uploadBodyLimit,
} from '@classmoji/utils/upload-limit';
import { uploadRefusalStatus } from '@classmoji/services';
import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess, pageMutationBlocked } from '~/utils/auth.server.ts';
import { uploadPageAsset } from '~/utils/content.server.ts';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '@classmoji/utils/upload-concurrency';

/**
 * Image/file upload endpoint.
 * Uploads to the page's assets folder on GitHub.
 *
 * POST /api/upload?pageId=<id>
 * Body: FormData with 'file'
 * Returns: `{ url, path, displayUrl }` — `url`/`path` are the repo path the
 * editor stores in the block; `displayUrl` is the signed URL it displays with
 * (null when the delivery layer is off, in which case the editor shows the
 * path and the legacy proxy resolves it).
 *
 * The page is named in the QUERY STRING, not the form, so the whole gate —
 * session, edit access on this page, the classroom's status — runs before a
 * byte of the body is read. The body is then read through a byte-counting
 * reader capped at one repository-sized file: a caller who may not upload here
 * never makes this process hold what they sent, and one who may cannot send
 * more than the repository would take.
 */
export const action = async ({ request }: { request: Request }) => {
  const pageId = new URL(request.url).searchParams.get('pageId');
  if (!pageId) {
    return Response.json({ error: 'No pageId provided' }, { status: 400 });
  }

  // Fetch page with classroom context
  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  // Require edit permission (staff in the page's classroom)
  const { membership } = await assertPageAccess({ request, page, accessType: 'edit' });

  // SEC4: uploads write to the content repo — enforce the platform-wide
  // classroom status gate (LOCKED/UNPUBLISHED are read-only for non-owners).
  // accessType 'edit' guarantees a membership (assertPageAccess threw otherwise).
  const blocked = membership ? pageMutationBlocked(page.classroom, membership.role) : null;
  if (blocked) return blocked;

  // One slot per upload in flight, given back in the `finally` below: the size
  // cap bounds one upload, this bounds how many this process holds at once.
  if (!acquireUploadSlot()) {
    return Response.json(
      { error: UPLOAD_BUSY_MESSAGE },
      { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
    );
  }
  try {
    return await receiveUpload(request, page);
  } finally {
    releaseUploadSlot();
  }
};

/** Read the file and commit it — once the caller holds a slot. */
async function receiveUpload(
  request: Request,
  page: Parameters<typeof uploadPageAsset>[0]
): Promise<Response> {
  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, uploadBodyLimit(REPO_REST_MAX_BYTES));
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return Response.json({ error: repoFileTooLargeMessage() }, { status: 413 });
    }
    throw error;
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }

  try {
    const { url, path, displayUrl } = await uploadPageAsset(page, file);
    return Response.json({ success: true, url, path, displayUrl });
  } catch (error: unknown) {
    // A file the storage router sends to media (a Pro video, or one over the
    // repository's cap on a classroom with media): 409 `USE_MEDIA`, which the
    // editor answers by sending it through the media upload instead.
    const routed = ClassmojiService.media.mediaRoutingResponse(error);
    if (routed) return routed;
    // A refusal the uploader can act on — too large (413), a type or extension
    // this classroom does not take (415), a name that is not one (400). Its
    // message is the sentence to show, and it is not a fault worth logging.
    const refused = uploadRefusalStatus(error);
    if (refused) {
      return Response.json({ error: (error as Error).message }, { status: refused });
    }
    console.error('[upload] Failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
