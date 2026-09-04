import {
  SHORT_CACHE_CONTROL,
  blobKey,
  contentHeaders,
  errorResponse,
  variantKey,
} from './cache.ts';
import { contentTypeForExtension, isRasterExtension } from './content-type.ts';
import type { Env } from './env.ts';
import { GitHubOrigin } from './origins/github.ts';
import { deliveryStrategy, type OriginAdapter } from './origins/types.ts';
import { withOriginRetry } from './token.ts';
import {
  MAX_TRANSFORM_SOURCE_BYTES,
  negotiateFormat,
  mediaTypeFor,
  readBounded,
  transformImage,
} from './transform.ts';
import { cacheControlFor, nowSeconds, type BlobVerification } from './verify.ts';

/** The success half of the verification union. */
type VerifiedBlob = Extract<BlobVerification, { ok: true }>;

// Typed as the interface, so the presign branch below is expressible even
// though the GitHub origin cannot presign.
const origin: OriginAdapter = new GitHubOrigin();

interface ServeOptions {
  classroomId: string;
  sha: string;
  contentType: string;
  cacheControl: string;
  /** HEAD: answer from R2 metadata when the object is there, and never buffer. */
  head?: boolean;
}

function storedHeaders(object: R2Object, fallbackType: string, cacheControl: string): Headers {
  const headers = contentHeaders(object.httpMetadata?.contentType ?? fallbackType, cacheControl);
  headers.set('ETag', object.httpEtag);
  // R2 knows the length without reading a byte, so there is no reason to make a
  // client guess at download progress.
  headers.set('Content-Length', String(object.size));
  return headers;
}

function storedResponse(
  object: R2ObjectBody,
  fallbackType: string,
  cacheControl: string
): Response {
  return new Response(object.body, { headers: storedHeaders(object, fallbackType, cacheControl) });
}

/**
 * A HEAD answered from R2's metadata alone — no bytes read, no origin touched.
 * Returns null when the object is not there, so the caller can fall through to
 * the full path (which will warm R2 for the HEAD after this one).
 */
async function storedHead(
  env: Env,
  key: string,
  fallbackType: string,
  cacheControl: string
): Promise<Response | null> {
  const object = await env.CACHE.head(key);
  if (!object) return null;
  return new Response(null, { headers: storedHeaders(object, fallbackType, cacheControl) });
}

/** The origin's own `Content-Length`, when it sent a usable one. */
function declaredLength(headers: Headers): number | null {
  const raw = headers.get('Content-Length');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Stream an origin body to the client while a tee'd copy lands in R2. Bytes are
 * never buffered here — this is the path every untransformed miss takes, and
 * the one the transform path falls back to when its source is too big to hold.
 */
function streamAndCache(
  env: Env,
  ctx: ExecutionContext,
  key: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
  cacheControl: string,
  contentLength: number | null
): Response {
  const [toClient, toCache] = body.tee();
  ctx.waitUntil(
    env.CACHE.put(key, toCache, { httpMetadata: { contentType } }).catch(error => {
      console.warn(`[content] failed to cache ${key}:`, error);
    })
  );
  const headers = contentHeaders(contentType, cacheControl);
  // Only ever forwarded, never computed: working it out would mean buffering
  // the very stream this path exists to avoid buffering.
  if (contentLength !== null) headers.set('Content-Length', String(contentLength));
  return new Response(toClient, { headers });
}

/** One shape for both ways a source can be too large: declared, and counted. */
function warnOversizedSource(sha: string, size: number | null): void {
  const measured = size === null ? 'over the' : `${size} bytes, over the`;
  console.warn(
    `[content] skipping transform for ${sha}: source is ${measured} ` +
      `${MAX_TRANSFORM_SOURCE_BYTES} byte ceiling`
  );
}

/**
 * Serve a blob by sha: R2 first, otherwise pull it from the origin and stream
 * it to the client while a tee'd copy lands in R2. Bytes are never buffered on
 * this path.
 */
export async function serveBlobBySha(
  env: Env,
  ctx: ExecutionContext,
  options: ServeOptions
): Promise<Response> {
  const key = blobKey(options.sha);

  if (options.head) {
    const head = await storedHead(env, key, options.contentType, options.cacheControl);
    if (head) return head;
  }

  const hit = await env.CACHE.get(key);
  if (hit) return storedResponse(hit, options.contentType, options.cacheControl);

  // Size is unknown before the fetch, so this always proxies today. The branch
  // is the seam for an origin that knows sizes and can presign large objects.
  //
  // NOT PRODUCTION-READY: `Response.redirect` bypasses `finalizeHeaders`, so
  // this reply would carry no CORS, no nosniff and no CSP, and it hands the
  // browser a URL this Worker no longer controls. Route it through
  // `finalizeHeaders` — and decide what the redirect target may set — before
  // any origin sets `canPresign` to true.
  if (deliveryStrategy(origin, undefined) === 'presign' && origin.presign) {
    const presign = origin.presign.bind(origin);
    const location = await withOriginRetry(env, options.classroomId, originRef =>
      presign({ ...originRef, sha: options.sha })
    );
    return Response.redirect(location, 302);
  }

  const response = await withOriginRetry(env, options.classroomId, ref =>
    origin.fetchBlob({ ...ref, sha: options.sha })
  );

  if (!response.ok || !response.body) {
    console.warn(`[content] origin blob ${options.sha}: ${response.status}`);
    return errorResponse(502, 'origin unavailable');
  }

  return streamAndCache(
    env,
    ctx,
    key,
    response.body,
    options.contentType,
    options.cacheControl,
    declaredLength(response.headers)
  );
}

/**
 * Materialize a blob's bytes for the transform path (R2 first, else origin,
 * caching the original on the way through).
 *
 * Returns a Response instead of bytes when there are none to hand back: an
 * origin failure, or a source past `MAX_TRANSFORM_SOURCE_BYTES`, which is
 * streamed untransformed on the short TTL a failed transform gets. Either way
 * the caller passes it straight through.
 */
async function loadOriginalBytes(
  env: Env,
  ctx: ExecutionContext,
  options: ServeOptions
): Promise<ArrayBuffer | Response> {
  const key = blobKey(options.sha);
  const hit = await env.CACHE.get(key);
  if (hit) {
    if (hit.size > MAX_TRANSFORM_SOURCE_BYTES) {
      warnOversizedSource(options.sha, hit.size);
      return storedResponse(hit, options.contentType, SHORT_CACHE_CONTROL);
    }
    return hit.arrayBuffer();
  }

  const response = await withOriginRetry(env, options.classroomId, ref =>
    origin.fetchBlob({ ...ref, sha: options.sha })
  );
  if (!response.ok || !response.body) {
    console.warn(`[content] origin blob ${options.sha}: ${response.status}`);
    return errorResponse(502, 'origin unavailable');
  }

  const declared = declaredLength(response.headers);
  if (declared !== null && declared > MAX_TRANSFORM_SOURCE_BYTES) {
    warnOversizedSource(options.sha, declared);
    return streamAndCache(
      env,
      ctx,
      key,
      response.body,
      options.contentType,
      SHORT_CACHE_CONTROL,
      declared
    );
  }

  const bytes = await readBounded(response.body, MAX_TRANSFORM_SOURCE_BYTES);
  if (bytes === null) {
    // The origin declared no size, so the ceiling could only be enforced by
    // counting - and the bytes counted are gone with the cancelled stream. The
    // untransformed path fetches it again and streams it, caching on the way.
    warnOversizedSource(options.sha, null);
    return serveBlobBySha(env, ctx, { ...options, cacheControl: SHORT_CACHE_CONTROL });
  }

  ctx.waitUntil(
    env.CACHE.put(key, bytes, { httpMetadata: { contentType: options.contentType } }).catch(
      error => {
        console.warn(`[content] failed to cache ${key}:`, error);
      }
    )
  );
  return bytes;
}

async function serveVariant(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  verified: VerifiedBlob,
  width: number,
  options: ServeOptions
): Promise<Response> {
  const format = negotiateFormat(verified.transform?.fmt, request.headers.get('Accept'));
  const key = variantKey(options.sha, width, format);

  if (options.head) {
    const head = await storedHead(env, key, mediaTypeFor(format), options.cacheControl);
    if (head) return head;
  }

  const hit = await env.CACHE.get(key);
  if (hit) return storedResponse(hit, mediaTypeFor(format), options.cacheControl);

  const original = await loadOriginalBytes(env, ctx, options);
  if (original instanceof Response) return original;

  const transformed = await transformImage(env, original, width, format);
  if (!transformed) {
    // Images could not handle it — serve the untransformed original rather
    // than a broken image, but on a short TTL. The tier's cache-control is
    // immutable for up to 30 days; a ten-minute Images quota blip must not pin
    // a 4 MB original at the edge for a month under a URL that asked for an
    // 800px variant. A minute later, the next request retries the transform.
    return new Response(original, {
      headers: contentHeaders(options.contentType, SHORT_CACHE_CONTROL),
    });
  }

  ctx.waitUntil(
    env.CACHE.put(key, transformed, { httpMetadata: { contentType: mediaTypeFor(format) } }).catch(
      error => {
        console.warn(`[content] failed to cache ${key}:`, error);
      }
    )
  );

  return new Response(transformed, {
    headers: contentHeaders(mediaTypeFor(format), options.cacheControl),
  });
}

export async function serveBlob(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  verified: VerifiedBlob
): Promise<Response> {
  const options: ServeOptions = {
    classroomId: verified.classroomId,
    sha: verified.sha,
    contentType: contentTypeForExtension(verified.ext),
    cacheControl: cacheControlFor(verified.tier, verified.exp, nowSeconds()),
    head: request.method === 'HEAD',
  };

  const width = verified.transform?.w;
  if (width && isRasterExtension(verified.ext)) {
    return serveVariant(env, ctx, request, verified, width, options);
  }

  return serveBlobBySha(env, ctx, options);
}
