/**
 * Serving one verified media URL.
 *
 * The same answer shape as a blob — `Accept-Ranges`, a 206 for a seek, a 416
 * for a seek past the end, the tier's cache-control, CORS, nosniff, the
 * sandboxing CSP, a `Content-Disposition` when the signature carried a
 * filename — built from the same `range.ts` and the same header pipeline in
 * `cache.ts`. What it does NOT do is everything the blob path exists for:
 *
 *   - no cache fill. The MEDIA bucket IS the store, so there is nothing to warm
 *     and nothing to write; this Worker never puts an object there.
 *   - no origin. A missing object is a 404, not a pull.
 *   - no redirect. `MediaOrigin.canPresign` is false: a presigned URL would
 *     leave `finalizeHeaders` behind.
 *   - no transform. A media object is video, audio or a document.
 *
 * That is why this is its own file rather than a branch inside `blob.ts`: the
 * two paths share their POLICY (range.ts, cache.ts) and share nothing else.
 */
import { asDownload, blobHeaders, errorResponse } from './cache.ts';
import type { Env } from './env.ts';
import { MediaOrigin, type MediaObjectRef } from './origins/media.ts';
import {
  contentRangeHeader,
  ifRangeMatches,
  parseRange,
  rangeLength,
  unsatisfiedRangeHeader,
  type ByteRange,
  type RangeOutcome,
} from './range.ts';
import { cacheControlFor, nowSeconds, type MediaVerification } from './verify.ts';

/** The success half of the verification union. */
type VerifiedMedia = Extract<MediaVerification, { ok: true }>;

const origin = new MediaOrigin();

/**
 * Headers for an object served out of the media bucket.
 *
 * `Content-Length` and `ETag` come straight from R2's metadata — it knows both
 * without reading a byte, and a client with no length has no download progress
 * and no way to evaluate an `If-Range` later.
 */
function objectHeaders(object: R2Object, contentType: string, cacheControl: string): Headers {
  const headers = blobHeaders(contentType, cacheControl);
  headers.set('ETag', object.httpEtag);
  headers.set('Content-Length', String(object.size));
  return headers;
}

/** A 206 for one byte range. `Content-Length` is the RANGE's length, not the object's. */
function partialResponse(
  body: BodyInit | null,
  contentType: string,
  cacheControl: string,
  etag: string,
  range: ByteRange,
  total: number
): Response {
  const headers = blobHeaders(contentType, cacheControl);
  headers.set('ETag', etag);
  headers.set('Content-Range', contentRangeHeader(range, total));
  headers.set('Content-Length', String(rangeLength(range)));
  return new Response(body, { status: 206, headers });
}

/**
 * 416 for a range naming bytes the object does not have. The unsatisfied form
 * of `Content-Range` (RFC 7233 §4.4) is what makes the retry right.
 */
function rangeNotSatisfiable(total: number): Response {
  const headers = blobHeaders('application/json; charset=utf-8', 'no-store');
  headers.set('Content-Range', unsatisfiedRangeHeader(total));
  return new Response(JSON.stringify({ error: 'range not satisfiable' }), { status: 416, headers });
}

/**
 * What to do about this request's `Range`, given the object we hold.
 *
 * `If-Range` is weighed first and its failure is a full 200, never an error: a
 * client saying "the range, but only if this is still the same file" and being
 * wrong must get the whole new file rather than a slice of it.
 */
function rangeOutcome(request: Request, etag: string, total: number): RangeOutcome {
  const range = request.headers.get('Range');
  if (range === null) return { kind: 'full' };
  if (!ifRangeMatches(request.headers.get('If-Range'), etag)) return { kind: 'full' };
  return parseRange(range, total);
}

/**
 * Serve one verified media URL.
 *
 * `verified.downloadFilename` is present only when the URL carried a signed
 * `dl`, and it is honoured only on the `download` tier — the one tier that is
 * `no-store` and lives ten minutes. Nothing else can mint that combination
 * (`signMediaUrl` refuses it), but the tier is what decides cacheability, and a
 * per-viewer filename must never end up on a reply a shared cache may keep.
 */
export async function serveMedia(
  env: Env,
  request: Request,
  verified: VerifiedMedia
): Promise<Response> {
  const response = await serveVerifiedMedia(env, request, verified);
  return verified.downloadFilename === undefined || verified.tier !== 'download'
    ? response
    : asDownload(response, verified.downloadFilename);
}

async function serveVerifiedMedia(
  env: Env,
  request: Request,
  verified: VerifiedMedia
): Promise<Response> {
  const ref: MediaObjectRef = {
    classroomId: verified.classroomId,
    mediaId: verified.mediaId,
    variant: verified.variant,
  };
  const cacheControl = cacheControlFor(verified.tier, verified.exp, nowSeconds());
  const head = request.method === 'HEAD';

  // A HEAD and a ranged GET are both settled from metadata first: the stored
  // size and etag decide the status, the headers and the byte positions before
  // any bytes are read — and only then is a `get` issued, for exactly those
  // bytes. A plain GET takes the one-call path.
  if (head || request.headers.get('Range') !== null) {
    const stored = await origin.head(env, ref);
    if (!stored) return notFound(ref);

    const { object, contentType } = stored;
    const outcome = rangeOutcome(request, object.httpEtag, object.size);
    if (outcome.kind === 'unsatisfiable') return rangeNotSatisfiable(object.size);

    if (outcome.kind === 'full') {
      const headers = objectHeaders(object, contentType, cacheControl);
      if (head) return new Response(null, { headers });
      const body = await origin.get(env, ref);
      if (!body) return notFound(ref);
      return new Response(body.object.body, { headers });
    }

    const { range } = outcome;
    if (head) {
      return partialResponse(null, contentType, cacheControl, object.httpEtag, range, object.size);
    }

    const body = await origin.get(env, ref, {
      offset: range.start,
      length: rangeLength(range),
    });
    if (!body) return notFound(ref);
    return partialResponse(
      body.object.body,
      contentType,
      cacheControl,
      object.httpEtag,
      range,
      object.size
    );
  }

  const body = await origin.get(env, ref);
  if (!body) return notFound(ref);
  return new Response(body.object.body, {
    headers: objectHeaders(body.object, body.contentType, cacheControl),
  });
}

/**
 * The object is not in the bucket — deleted, or never completed.
 *
 * A 404 and not a 502: there is no origin behind this bucket to be unavailable.
 * The line carries the classroom and the media id because both are ours and
 * neither is a credential; the signature and the query never appear in a log.
 */
function notFound(ref: MediaObjectRef): Response {
  console.warn(
    `[content] 404 media classroom=${ref.classroomId} media=${ref.mediaId} variant=${ref.variant}`
  );
  return errorResponse(404, 'not found');
}
