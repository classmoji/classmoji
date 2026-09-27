import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  UploadTooLargeError,
  declaredBodyTooLarge,
  readLimitedBody,
} from '@classmoji/utils/upload-limit';
import { assertClassroomAccess, assertClassroomMutationAllowed, requireAuth } from './server.ts';

/**
 * The media HTTP API, once, for every app that mounts it.
 *
 * `/api/media/uploads`, `…/:mediaId/parts`, `…/:mediaId/complete`,
 * `…/:mediaId/abort`, `DELETE /api/media/:mediaId` and `GET /api/media/list`
 * are the same six endpoints in the webapp, the pages app and the slides app:
 * the upload client (`uploadMultipart`) talks to whichever origin its editor is
 * on, and every one of them has to answer identically. So the handlers live
 * here and each app's route file is a one-line re-export — a copy per app would
 * be a chance per app to answer 500 where the client expects 409.
 *
 * ## Why this package
 *
 * The handlers are plain `({ request, params }) => Promise<Response>` and need
 * two things: the session and classroom gates (`./server.ts`) and the media
 * service (`@classmoji/services`). This package already depends on services;
 * services cannot depend on this package without making the workspace graph
 * cyclic. So this is the one place both are reachable — and it is server-only
 * already, which is what these must be.
 *
 * ## The shared plumbing
 *
 * Who may call them, what a body may be, and how a `MediaError` becomes a
 * response. Every route answers the SAME error shape — `{ error: 'CODE' }` with
 * the same status per code — and the upload client switches on `body.error`.
 */

/** A route handler as React Router calls an action or a loader: two fields matter. */
export interface MediaHandlerArgs {
  request: Request;
  params: Record<string, string | undefined>;
}

/**
 * The roles that may write media.
 *
 * The teaching team, which is the gate a DECK save uses
 * (`requireClassroomTeachingTeam`) rather than the narrower owner/teacher gate
 * on pages. Media is a shared classroom resource an assistant building a deck
 * needs to be able to add to, and it is the same set that can already commit
 * files into the content repo — so this widens nothing that was not already
 * reachable, it only moves where the bytes land.
 *
 * Pro is NOT checked here. It is the service's job, so every caller — routes,
 * MCP, a future task — gets the same answer, and `PRO_REQUIRED` stays
 * distinguishable from "you are not on this teaching team".
 */
const MEDIA_EDIT_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

/**
 * The most JSON one of these routes will read.
 *
 * Every body is small and bounded: the largest is `complete`, and a 2 GiB
 * file in 32 MiB parts is 64 entries of about sixty bytes. 64 KiB is two orders
 * of magnitude of headroom and still refuses a body sent to make the server
 * allocate. `request.json()` has no limit of its own, which is the whole reason
 * this exists.
 */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** `{ error: 'CODE' }` — the shape the upload client reads. */
export function mediaError(
  code: string,
  status: number,
  extra: Record<string, unknown> = {}
): Response {
  return Response.json({ error: code, ...extra }, { status });
}

/**
 * Which status each refusal is, in one table.
 *
 * `BAD_STATE`, `SIZE_MISMATCH` and `VERIFY_FAILED` are all 409 and that is
 * deliberate: each means "the object is not in the state this call assumes",
 * and the distinct `error` code in the body is what tells them apart for anyone
 * who cares.
 */
const STATUS_FOR: Record<string, number> = {
  NOT_CONFIGURED: 503,
  PRO_REQUIRED: 403,
  // The deployment is fine; this CLASSROOM cannot serve content yet, which is
  // a state the caller can change — 409, not the 503 that means "come back
  // when an operator has fixed the server".
  DELIVERY_REQUIRED: 409,
  FILE_TOO_LARGE: 413,
  KIND_NOT_ALLOWED: 422,
  QUOTA_EXCEEDED: 409,
  NOT_FOUND: 404,
  BAD_STATE: 409,
  SIZE_MISMATCH: 409,
  VERIFY_FAILED: 409,
  // Gone for good: the reservation lapsed and the upload was cancelled, so no
  // retry of the same call can succeed. The client starts over.
  UPLOAD_EXPIRED: 410,
};

/**
 * A thrown error → the response for it.
 *
 * A `Response` thrown by an auth helper is re-thrown untouched: it is already
 * the answer, and wrapping it would turn a 403 with an audit row behind it into
 * a generic 500. A `MediaError` becomes its code and status. Anything else is a
 * genuine fault and gets a 500 with no detail — the message may name a bucket
 * or a key, and the client has nothing useful to do with either.
 */
export function mediaErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error;

  if (ClassmojiService.media.isMediaError(error)) {
    const extra: Record<string, unknown> = { message: error.message };
    if (error.code === 'QUOTA_EXCEEDED') {
      extra.usedBytes = error.usedBytes;
      extra.quotaBytes = error.quotaBytes;
    }
    return mediaError(error.code, STATUS_FOR[error.code] ?? 400, extra);
  }

  console.error('[api.media] Unexpected failure:', error);
  return mediaError('INTERNAL', 500, { message: 'Something went wrong.' });
}

/** Read a small JSON object, or throw the response that refuses it. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const tooLarge = () => mediaError('BAD_REQUEST', 413, { message: 'Request body is too large.' });
  if (declaredBodyTooLarge(request.headers, MAX_JSON_BODY_BYTES)) throw tooLarge();

  // The header is a claim — a chunked request declares no length at all — so
  // the bytes are counted AS THEY ARRIVE, and the read is abandoned the moment
  // the count crosses the cap, rather than buffering the whole body and
  // measuring it afterwards.
  let text = '';
  if (request.body) {
    try {
      text = new TextDecoder().decode(await readLimitedBody(request.body, MAX_JSON_BODY_BYTES));
    } catch (error: unknown) {
      if (error instanceof UploadTooLargeError) throw tooLarge();
      throw error;
    }
  }

  try {
    const parsed = text.length === 0 ? {} : JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw mediaError('BAD_REQUEST', 400, { message: 'Expected a JSON object.' });
  }
}

/**
 * Teaching-team access on a classroom the caller named — edit access, unless
 * `mutation: false` says the call only reads.
 *
 * `maskDenialAs404` turns the access gate's refusal into the same 404 an
 * unknown media id gets. Only the ACCESS check is masked: the audit row is
 * still written (`assertClassroomAccess` writes it before it throws), and the
 * locked/unpublished refusal below is left alone, because that one can only
 * reach somebody who is already on the classroom's teaching team and so
 * answers a question they could have asked anyway — while an owner told "no
 * such media object" about their own locked classroom would go looking for a
 * file nobody deleted.
 *
 * `mutation: false` skips the locked/unpublished gate: that gate is about
 * WRITES, and listing what a classroom already holds changes nothing.
 */
export async function requireMediaAccess(
  request: Request,
  classroomId: string,
  attemptedAction: string,
  {
    maskDenialAs404 = false,
    mutation = true,
  }: { maskDenialAs404?: boolean; mutation?: boolean } = {}
): Promise<{ userId: string; classroom: { id: string } }> {
  let granted;
  try {
    granted = await assertClassroomAccess({
      request,
      classroomId,
      allowedRoles: [...MEDIA_EDIT_ROLES],
      resourceType: 'MEDIA',
      attemptedAction,
    });
  } catch (error) {
    if (maskDenialAs404 && error instanceof Response && error.status === 403) {
      throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });
    }
    throw error;
  }

  const { classroom, userId, membership } = granted;
  if (mutation) {
    assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  }
  return { userId, classroom: { id: classroom.id } };
}

/**
 * The classroom one media object belongs to, gated.
 *
 * `parts`, `complete`, `abort` and `delete` are addressed by media id alone — the upload
 * client holds nothing else by then — so the classroom has to be read off the
 * row before there is anything to authorize against. Three things keep that
 * from being a way to ask which ids exist:
 *
 *   - the session is required FIRST, so an anonymous caller gets 401 for every
 *     id, real or not, and learns nothing;
 *   - an id belonging to a classroom the caller cannot edit answers the SAME
 *     404 as an id that was never issued. These routes therefore have no
 *     reply that means "this exists, elsewhere" — which a 403 would have been.
 *     The audit row is still written, so a real attempt is still visible to us;
 *   - the id is a v4 UUID, so the set cannot be walked in the first place.
 *
 * `listMedia` and the resolver reach the same place by a different road: they
 * put `classroom_id` in the WHERE clause, so a foreign row is never in hand to
 * be rejected. Here the row has to be read to find the classroom at all, so the
 * equivalence is restored afterwards instead.
 */
export async function requireMediaAccessForObject(
  request: Request,
  mediaId: string,
  attemptedAction: string
): Promise<{ userId: string; classroom: { id: string } }> {
  await requireAuth(request);

  const row = await getPrisma().mediaObject.findUnique({
    where: { id: mediaId },
    select: { classroom_id: true },
  });
  if (!row) throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });

  return requireMediaAccess(request, row.classroom_id, attemptedAction, {
    maskDenialAs404: true,
  });
}

/** A path param that has to be a media id, or the 404 that refuses it. */
export function requireMediaId(value: string | undefined): string {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw mediaError('NOT_FOUND', 404, { message: 'No such media object.' });
  }
  return id;
}

/** Refuse anything but the one method a route answers. */
export function requireMethod(request: Request, method: string): void {
  if (request.method.toUpperCase() !== method) {
    throw mediaError('METHOD_NOT_ALLOWED', 405, { message: `Use ${method}.` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/media/uploads` — open a multipart upload.
 *
 * Thin over `ClassmojiService.media.createUpload`: this handler decides who is
 * asking and what shape the body is, and nothing else. Every refusal that has
 * anything to do with media — the deployment having no bucket, the classroom
 * not being Pro, the file being too big or the wrong kind, the quota being
 * full — is the service's, so the same answer comes back whichever app asked.
 *
 * The response carries `contentType` because the browser puts it on each part
 * PUT; it is the type the SERVER assigned from the extension, never the one the
 * file picker guessed.
 */
export async function mediaUploadsAction({ request }: MediaHandlerArgs): Promise<Response> {
  try {
    requireMethod(request, 'POST');

    // Read before the classroom check on purpose: capped at 64 KB, no file bytes, and the classroom id lives in it.
    const body = await readJsonBody(request);
    const classroomId = typeof body.classroomId === 'string' ? body.classroomId : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : NaN;

    if (!classroomId || !filename) {
      return mediaError('BAD_REQUEST', 400, { message: 'classroomId and filename are required.' });
    }

    // A body with no size, one carrying NaN/Infinity, or one declaring zero or
    // fewer bytes is a MALFORMED request, not a file that is too large — and
    // 413 is what the upload client shows the uploader as "your file is over
    // the limit". Refusing it here keeps the service's FILE_TOO_LARGE meaning
    // one thing. (The service refuses these too; it just has the one code to
    // do it with.)
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
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
}

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
export async function mediaPartsAction({ params, request }: MediaHandlerArgs): Promise<Response> {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    // Read before the access check on purpose: capped at 64 KB, no file bytes (part numbers only), validated before the row lookup.
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
}

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
export async function mediaCompleteAction({
  params,
  request,
}: MediaHandlerArgs): Promise<Response> {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    // Read before the access check on purpose: capped at 64 KB, no file bytes (part etags only), validated before the row lookup.
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
}

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
export async function mediaAbortAction({ params, request }: MediaHandlerArgs): Promise<Response> {
  try {
    requireMethod(request, 'POST');

    const mediaId = requireMediaId(params.mediaId);
    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'abort_upload');

    await ClassmojiService.media.abortUpload({ classroom, mediaId });

    return new Response(null, { status: 204 });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}

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
export async function mediaDeleteAction({ params, request }: MediaHandlerArgs): Promise<Response> {
  try {
    requireMethod(request, 'DELETE');

    const mediaId = requireMediaId(params.mediaId);
    const { classroom } = await requireMediaAccessForObject(request, mediaId, 'delete_media');

    await ClassmojiService.media.deleteMedia({ classroom, mediaId });

    return new Response(null, { status: 204 });
  } catch (error) {
    return mediaErrorResponse(error);
  }
}
