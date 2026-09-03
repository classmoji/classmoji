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
import { negotiateFormat, mediaTypeFor, transformImage } from './transform.ts';
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
}

function storedResponse(
  object: R2ObjectBody,
  fallbackType: string,
  cacheControl: string
): Response {
  const headers = contentHeaders(object.httpMetadata?.contentType ?? fallbackType, cacheControl);
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
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

  const [toClient, toCache] = response.body.tee();
  ctx.waitUntil(
    env.CACHE.put(key, toCache, { httpMetadata: { contentType: options.contentType } }).catch(
      error => {
        console.warn(`[content] failed to cache ${key}:`, error);
      }
    )
  );

  return new Response(toClient, {
    headers: contentHeaders(options.contentType, options.cacheControl),
  });
}

/**
 * Materialize a blob's bytes for the transform path (R2 first, else origin,
 * caching the original on the way through). Returns an error Response when the
 * origin fails, so the caller can pass it straight back.
 */
async function loadOriginalBytes(
  env: Env,
  ctx: ExecutionContext,
  options: ServeOptions
): Promise<ArrayBuffer | Response> {
  const key = blobKey(options.sha);
  const hit = await env.CACHE.get(key);
  if (hit) return hit.arrayBuffer();

  const response = await withOriginRetry(env, options.classroomId, ref =>
    origin.fetchBlob({ ...ref, sha: options.sha })
  );
  if (!response.ok) {
    console.warn(`[content] origin blob ${options.sha}: ${response.status}`);
    return errorResponse(502, 'origin unavailable');
  }

  const bytes = await response.arrayBuffer();
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
  };

  const width = verified.transform?.w;
  if (width && isRasterExtension(verified.ext)) {
    return serveVariant(env, ctx, request, verified, width, options);
  }

  return serveBlobBySha(env, ctx, options);
}
