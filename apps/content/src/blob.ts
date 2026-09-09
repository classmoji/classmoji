import {
  SHORT_CACHE_CONTROL,
  blobHeaders,
  blobKey,
  contentHeaders,
  errorResponse,
  variantKey,
} from './cache.ts';
import { contentTypeForExtension, isRasterExtension } from './content-type.ts';
import type { Env } from './env.ts';
import { GitHubOrigin } from './origins/github.ts';
import { deliveryStrategy, type OriginAdapter } from './origins/types.ts';
import {
  contentRangeHeader,
  ifRangeMatches,
  parseRange,
  rangeLength,
  sliceStream,
  unsatisfiedRangeHeader,
  type ByteRange,
  type RangeOutcome,
} from './range.ts';
import { withOriginRetry } from './token.ts';
import type { OriginTokenTiming } from './token.ts';
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

export interface ServeOptions {
  classroomId: string;
  sha: string;
  contentType: string;
  cacheControl: string;
  /** HEAD: answer from R2 metadata when the object is there, and never buffer. */
  head?: boolean;
  /** The request's `Range` header verbatim, or null when it sent none. */
  range?: string | null;
  /** The request's `If-Range` header verbatim, or null when it sent none. */
  ifRange?: string | null;
}

/**
 * The parts of a request that decide HOW a blob is served rather than WHICH
 * one — so the blob route and the theme route cannot drift on it.
 */
export function deliveryOptions(
  request: Request
): Pick<ServeOptions, 'head' | 'range' | 'ifRange'> {
  return {
    head: request.method === 'HEAD',
    range: request.headers.get('Range'),
    ifRange: request.headers.get('If-Range'),
  };
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
  const headers = blobHeaders(contentType, cacheControl);
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
 * A 206 for one byte range.
 *
 * Everything a full 200 carries — the type the signed extension names, the
 * tier's cache-control, CORS, nosniff, the sandboxing CSP — plus the two
 * headers that make it partial. `Content-Length` is the length of the RANGE and
 * not of the object; `Content-Range` is what says where the rest of it went.
 *
 * `etag` is null on the origin-miss path, where the object is still on its way
 * into R2 and has no stored validator yet. An `ETag` is not required on a 206,
 * and inventing one the R2 write would then disagree with is worse than leaving
 * it off: the next request is a cache hit and carries the real one.
 */
function partialResponse(
  body: BodyInit | null,
  options: ServeOptions,
  etag: string | null,
  range: ByteRange,
  total: number
): Response {
  const headers = blobHeaders(options.contentType, options.cacheControl);
  if (etag !== null) headers.set('ETag', etag);
  headers.set('Content-Range', contentRangeHeader(range, total));
  headers.set('Content-Length', String(rangeLength(range)));
  return new Response(body, { status: 206, headers });
}

/**
 * 416 for a range naming bytes the object does not have.
 *
 * The unsatisfied-range form of `Content-Range` is required by RFC 7233 §4.4,
 * and it is the only thing that makes the refusal actionable: it tells the
 * client how big the object really is, so the retry can be right.
 */
function rangeNotSatisfiable(total: number): Response {
  const headers = blobHeaders('application/json; charset=utf-8', 'no-store');
  headers.set('Content-Range', unsatisfiedRangeHeader(total));
  return new Response(JSON.stringify({ error: 'range not satisfiable' }), { status: 416, headers });
}

/**
 * What to do about this request's `Range`, given the object we actually hold.
 *
 * `If-Range` is weighed first and its failure is a full 200, never an error:
 * a client saying "the range, but only if this is still the same file" and
 * being wrong must get the whole new file rather than a slice of it.
 */
function rangeOutcome(options: ServeOptions, etag: string, total: number): RangeOutcome {
  if (options.range === undefined || options.range === null) return { kind: 'full' };
  if (!ifRangeMatches(options.ifRange, etag)) return { kind: 'full' };
  return parseRange(options.range, total);
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
  const headers = blobHeaders(contentType, cacheControl);
  // Only ever forwarded, never computed: working it out would mean buffering
  // the very stream this path exists to avoid buffering.
  if (contentLength !== null) headers.set('Content-Length', String(contentLength));
  return new Response(toClient, { headers });
}

/**
 * Every origin pull, timed and split into its two legs.
 *
 * ## Why this line exists
 *
 * An R2 hit is measured in milliseconds. A MISS was measured on staging at
 * 4–25 seconds of wall time against about 5ms of CPU, which says the whole cost
 * is waiting — but not on what. There are exactly two things it can be waiting
 * on, and they have completely different fixes: minting an installation token
 * (a POST to the webapp, which on an autostopping environment can be a cold
 * start), or reading the blob out of GitHub. Splitting them is the entire point;
 * a single "slow pull" number would have left the question open.
 *
 * `token=<ms> (cached|minted)` says which of those it was — a cached token is
 * module-map work and near zero, so a large number beside `cached` would itself
 * be news. `blob=<ms>` is the remainder: the pull's wall time minus whatever the
 * token legs cost, which is the GitHub leg and nothing else.
 *
 * ## What it must never contain
 *
 * No token, no signature, no query string. The sha is content-addressed and
 * public by construction, and everything else on the line is a number. This is
 * an INFO line rather than a warning: it describes healthy traffic, and the
 * levels an operator is told to search are reserved for the 403/404/502 lines
 * that mean something has gone wrong.
 *
 * `status=0` is the one shape that is not an HTTP status: it means the pull
 * threw before any response existed — a timeout, a refused socket — and is
 * followed by the router's own 502. `bytes=unknown` is ordinary rather than a
 * failure: GitHub gzips text, so `Content-Length` describes an encoded body the
 * runtime has already decoded, and `declaredLength` correctly refuses to report
 * a number it would be wrong about.
 */
function logOriginPull(
  sha: string,
  token: { ms: number; source: OriginTokenTiming['source'] },
  blobMs: number,
  response: Response | null
): void {
  const status = response?.status ?? 0;
  const length = response ? declaredLength(response.headers) : null;
  console.info(
    `[content] origin pull sha=${sha} token=${token.ms}ms (${token.source}) ` +
      `blob=${blobMs}ms status=${status} bytes=${length ?? 'unknown'}`
  );
}

/**
 * One blob pull from the origin, with the token and blob legs measured.
 *
 * Every path that reaches past R2 goes through here, so there is one place the
 * timing is taken and one shape it is reported in. Token acquisitions are
 * ACCUMULATED because `withOriginRetry` can make two (a 401 costs a mint, a
 * drop and a re-mint), and a line that reported only the second would hide the
 * one that made the request slow. The source degrades to `minted` if any leg
 * minted, for the same reason.
 */
async function pullBlobFromOrigin(env: Env, classroomId: string, sha: string): Promise<Response> {
  const token = { ms: 0, source: 'cached' as OriginTokenTiming['source'] };
  const startedAt = Date.now();
  let response: Response | null = null;
  try {
    response = await withOriginRetry(
      env,
      classroomId,
      ref => origin.fetchBlob({ ...ref, sha }),
      timing => {
        token.ms += timing.ms;
        if (timing.source === 'minted') token.source = 'minted';
      }
    );
    return response;
  } finally {
    // In `finally` so a pull that THREW — the timeout case, the one most worth
    // seeing — is timed and logged exactly like one that answered.
    logOriginPull(sha, token, Math.max(0, Date.now() - startedAt - token.ms), response);
  }
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
 * Answer from an object R2 already holds, with its metadata already in hand.
 *
 * Returns null when the object went away between the `head` and the `get` — an
 * expiry or a lifecycle delete landing mid-request — so the caller falls
 * through to the origin rather than inventing a 404 for a blob that exists.
 */
async function serveStored(
  env: Env,
  key: string,
  stored: R2Object,
  options: ServeOptions
): Promise<Response | null> {
  const outcome = rangeOutcome(options, stored.httpEtag, stored.size);

  if (outcome.kind === 'unsatisfiable') return rangeNotSatisfiable(stored.size);

  if (outcome.kind === 'full') {
    const headers = storedHeaders(stored, options.contentType, options.cacheControl);
    if (options.head) return new Response(null, { headers });
    const hit = await env.CACHE.get(key);
    if (!hit) return null;
    return new Response(hit.body, { headers });
  }

  const { range } = outcome;
  if (options.head) return partialResponse(null, options, stored.httpEtag, range, stored.size);

  // R2's own ranged read: only these bytes leave storage, which is what makes a
  // seek into the middle of a video cost the same as a seek into the start.
  const hit = await env.CACHE.get(key, {
    range: { offset: range.start, length: rangeLength(range) },
  });
  if (!hit) return null;
  return partialResponse(hit.body, options, stored.httpEtag, range, stored.size);
}

/**
 * A ranged request that missed the cache.
 *
 * Answering it with the whole object is the exact bug this file exists to fix,
 * so the miss path has to produce a 206 as well — and it has to do so without
 * giving up the cache write, because the point is that the SECOND request for
 * that video is an R2 hit.
 *
 * Two shapes, chosen by whether the origin said how long the body is:
 *
 *   - Length known. The body is tee'd: one branch runs to the end and lands in
 *     R2 exactly as an unranged miss would, and the client is handed a slice of
 *     the other. Nothing is buffered, so this is a path a 40 MB video can take —
 *     and it is the path media does take, because GitHub serves media
 *     identity-encoded with a real `Content-Length`.
 *   - Length unknown. `Content-Range` needs a total and the only way to learn
 *     one is to count, so the body is held — under the same ceiling, and for the
 *     same reason, as `putCacheBranch`. Text arrives this way (GitHub gzips it
 *     and the runtime decodes it); media does not.
 */
async function serveRangeFromOrigin(
  env: Env,
  ctx: ExecutionContext,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: ServeOptions,
  declared: number | null
): Promise<Response> {
  const full = () =>
    streamAndCache(env, ctx, key, body, options.contentType, options.cacheControl, declared);

  // Nothing is stored, so there is no validator to weigh an `If-Range` against.
  // RFC 7233 §3.2: a server that cannot evaluate it treats the request as an
  // ordinary GET, which is the conditional working as designed.
  if (options.ifRange !== undefined && options.ifRange !== null) return full();

  if (declared !== null) {
    const outcome = parseRange(options.range, declared);
    if (outcome.kind === 'full') return full();

    const [toClient, toCache] = body.tee();
    ctx.waitUntil(putCacheBranch(env, key, toCache, options.contentType, declared));

    if (outcome.kind === 'unsatisfiable') {
      // The client gets no bytes, but the pull is already paid for: cancel only
      // this branch and let the other finish, so the corrected retry is a hit.
      await toClient.cancel().catch(() => {});
      return rangeNotSatisfiable(declared);
    }

    const { range } = outcome;
    return partialResponse(
      sliceStream(toClient, range.start, range.end),
      options,
      null,
      range,
      declared
    );
  }

  const bytes = await readBounded(body, MAX_UNKNOWN_LENGTH_CACHE_BYTES);
  if (bytes === null) {
    // Counting was the only way to a total and the count blew the ceiling, so
    // there is no `Content-Range` to send and the counted bytes went with the
    // cancelled stream. The object is re-pulled and streamed whole: a 200 to a
    // range request, and the one case left where that still happens. Only an
    // enormous body whose length the origin never declared reaches here, which
    // no media type does.
    console.warn(
      `[content] serving ${key} whole: unknown-length origin body over the ` +
        `${MAX_UNKNOWN_LENGTH_CACHE_BYTES} byte ceiling, so no range could be resolved`
    );
    return serveBlobBySha(env, ctx, { ...options, range: null, ifRange: null });
  }

  const total = bytes.byteLength;
  ctx.waitUntil(
    env.CACHE.put(key, bytes, { httpMetadata: { contentType: options.contentType } }).catch(
      error => {
        console.warn(`[content] failed to cache ${key}: ${messageOf(error)}`);
      }
    )
  );

  const outcome = parseRange(options.range, total);
  if (outcome.kind === 'unsatisfiable') return rangeNotSatisfiable(total);
  if (outcome.kind === 'full') {
    const headers = blobHeaders(options.contentType, options.cacheControl);
    headers.set('Content-Length', String(total));
    return new Response(bytes, { headers });
  }

  const { range } = outcome;
  return partialResponse(bytes.slice(range.start, range.end + 1), options, null, range, total);
}

/**
 * Serve a blob by sha: R2 first, otherwise pull it from the origin and stream
 * it to the client while a tee'd copy lands in R2. Bytes are never buffered on
 * this path unless a range has to be resolved against a length the origin never
 * declared.
 */
export async function serveBlobBySha(
  env: Env,
  ctx: ExecutionContext,
  options: ServeOptions
): Promise<Response> {
  const key = blobKey(options.sha);

  // A HEAD and a ranged GET are both settled from metadata: the stored size and
  // etag decide the status, the headers and the byte positions before a single
  // byte is read — and only then is a `get` issued, for exactly those bytes.
  // A plain GET still takes the one-call path it always did.
  if (options.head || (options.range !== undefined && options.range !== null)) {
    const stored = await env.CACHE.head(key);
    if (stored) {
      const served = await serveStored(env, key, stored, options);
      if (served) return served;
    }
  } else {
    const hit = await env.CACHE.get(key);
    if (hit) return storedResponse(hit, options.contentType, options.cacheControl);
  }

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

  const response = await pullBlobFromOrigin(env, options.classroomId, options.sha);

  if (!response.ok || !response.body) {
    console.warn(`[content] origin blob ${options.sha}: ${response.status}`);
    return errorResponse(502, 'origin unavailable');
  }

  const declared = declaredLength(response.headers);

  if (options.range !== undefined && options.range !== null) {
    return serveRangeFromOrigin(env, ctx, key, response.body, options, declared);
  }

  return streamAndCache(
    env,
    ctx,
    key,
    response.body,
    options.contentType,
    options.cacheControl,
    declared
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

  const response = await pullBlobFromOrigin(env, options.classroomId, options.sha);
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
    ...deliveryOptions(request),
  };

  const width = verified.transform?.w;
  if (width && isRasterExtension(verified.ext)) {
    // A `Range` on a `?w=…&fmt=…` URL is dropped rather than served. The
    // variant path answers out of a DIFFERENT object than the one the range was
    // computed against by whoever sent it, the clients that seek are media
    // players, and no media player fetches a resized still. RFC 7233 §3.1 lets
    // a server ignore a `Range`; the reply is the full 200 it has always been.
    return serveVariant(env, ctx, request, verified, width, {
      ...options,
      range: null,
      ifRange: null,
    });
  }

  return serveBlobBySha(env, ctx, options);
}
