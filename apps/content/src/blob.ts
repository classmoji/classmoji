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

/**
 * What a caught rejection actually says. Workers Logs renders a thrown object
 * as a bare stack, so every cache warning logs this instead.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * Headers for an object served out of R2.
 *
 * `contentType` is the type the SIGNED EXTENSION says, and the stored
 * `httpMetadata.contentType` is deliberately ignored. R2 keys are
 * content-addressed — `blobs/{sha}`, no classroom in the key — so one object is
 * shared by every classroom and every path that holds those bytes, and whatever
 * extension happened to be fetched FIRST wrote the stored type. A stylesheet
 * whose bytes also live at a `.txt` path anywhere in the fleet would then be
 * served `text/plain` to everyone, and `nosniff` (correctly) makes the browser
 * refuse it as a stylesheet.
 *
 * The signed extension is per-request and inside the signature, so it is both
 * correct for this caller and unforgeable. The stored value can only ever be a
 * different caller's answer to a different question.
 */
function storedHeaders(object: R2Object, contentType: string, cacheControl: string): Headers {
  const headers = contentHeaders(contentType, cacheControl);
  headers.set('ETag', object.httpEtag);
  // R2 knows the length without reading a byte, so there is no reason to make a
  // client guess at download progress.
  headers.set('Content-Length', String(object.size));
  return headers;
}

function storedResponse(object: R2ObjectBody, contentType: string, cacheControl: string): Response {
  return new Response(object.body, { headers: storedHeaders(object, contentType, cacheControl) });
}

/**
 * A HEAD answered from R2's metadata alone — no bytes read, no origin touched.
 * Returns null when the object is not there, so the caller can fall through to
 * the full path (which will warm R2 for the HEAD after this one).
 */
async function storedHead(
  env: Env,
  key: string,
  contentType: string,
  cacheControl: string
): Promise<Response | null> {
  const object = await env.CACHE.head(key);
  if (!object) return null;
  return new Response(null, { headers: storedHeaders(object, contentType, cacheControl) });
}

/**
 * The origin's own `Content-Length`, when it sent one we can honestly forward.
 *
 * A compressed response is the trap. The runtime adds `Accept-Encoding` to
 * every subrequest and GitHub gzips text, so `Content-Length` describes the
 * ENCODED body — but reading `response.body` (to tee it, here) hands us the
 * decoded bytes. Copying the header onto the decoded stream promises a length
 * we then fail to deliver, and the browser aborts with
 * ERR_CONTENT_LENGTH_MISMATCH on every cold css, svg or json blob. When the
 * origin says it encoded the body, we say nothing about its length.
 *
 * `Number` is too generous on its own: it reads '0x10' as 16 and ' 12 ' as 12,
 * so the digits are checked before the conversion.
 */
function declaredLength(headers: Headers): number | null {
  if (headers.has('Content-Encoding')) return null;
  const raw = headers.get('Content-Length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Ceiling on a cache copy we have to hold in memory because the origin never
 * said how long it was. Text blobs — `content.json`, `index.html`, css — are
 * kilobytes, and images arrive identity-encoded with a length, so nothing on
 * the normal path comes near this. It is here so a pathological body cannot
 * trade a cache write for the isolate's memory.
 */
export const MAX_UNKNOWN_LENGTH_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Put the tee'd cache branch into R2, buffering it only when we must.
 *
 * R2 accepts a `ReadableStream` only when the runtime knows its length up
 * front, which it does from the origin's `Content-Length` — and only when the
 * origin sent one it did not encode. GitHub gzips text, so every
 * `content.json`, `index.html` and stylesheet arrives with the length of the
 * ENCODED body while `tee()` hands us the decoded bytes: length unknown, and
 * the streaming put rejects. That failure is silent to the client (the write is
 * in `waitUntil`), so text was served correctly and re-pulled from GitHub on
 * every single read, never landing in R2 or at the edge.
 *
 * With no length there is nothing to declare up front, so the only way to write
 * it is to hold it. `readBounded` caps how much — past the ceiling the copy is
 * dropped rather than cached, which costs a re-fetch and never the isolate.
 */
async function putCacheBranch(
  env: Env,
  key: string,
  toCache: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: number | null
): Promise<void> {
  try {
    if (contentLength !== null) {
      await env.CACHE.put(key, toCache, { httpMetadata: { contentType } });
      return;
    }
    const bytes = await readBounded(toCache, MAX_UNKNOWN_LENGTH_CACHE_BYTES);
    if (bytes === null) {
      // The size can only be named by buffering it, which is the thing the
      // ceiling exists to refuse.
      console.warn(
        `[content] not caching ${key}: unknown-length origin body over the ` +
          `${MAX_UNKNOWN_LENGTH_CACHE_BYTES} byte ceiling`
      );
      return;
    }
    await env.CACHE.put(key, bytes, { httpMetadata: { contentType } });
  } catch (error) {
    // The message, not the error: Workers Logs renders a thrown object as a
    // stack, and the stack of a caught R2 rejection says nothing about why.
    console.warn(`[content] failed to cache ${key}: ${messageOf(error)}`);
  }
}

/**
 * Stream an origin body to the client while a tee'd copy lands in R2. The
 * client's half always streams — this is the path every untransformed miss
 * takes, and the one the transform path falls back to when its source is too
 * big to hold. Only the cache half is ever buffered, and only when the origin
 * left its length unknown.
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
  ctx.waitUntil(putCacheBranch(env, key, toCache, contentType, contentLength));
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
        console.warn(`[content] failed to cache ${key}: ${messageOf(error)}`);
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

  // A HEAD on a COLD variant deliberately falls through to the whole transform,
  // paying an Images call for a reply that carries no bytes. The alternative —
  // HEAD the original and answer from its headers — would be cheaper and wrong:
  // it would report the original's content type and length for a URL that asked
  // for an 800px webp, which is the one thing a HEAD exists to tell you. The
  // transform is cached on the way past, so the cost is paid once and the GET
  // behind it is a hit. HEAD on an image variant is rare (monitoring, not
  // browsers), so this is not a hot path.
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
        console.warn(`[content] failed to cache ${key}: ${messageOf(error)}`);
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
