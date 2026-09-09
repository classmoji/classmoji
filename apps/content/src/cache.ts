/**
 * R2 key derivation and the response headers every reply carries.
 *
 * Keys are content-addressed, so they never encode a classroom: two classrooms
 * that reference the same blob share one cached object. Access is decided by
 * the signature, not by the key.
 */

export function blobKey(sha: string): string {
  return `blobs/${sha}`;
}

/** A width/format variant of a blob. `format` is always concrete — never 'auto'. */
export function variantKey(sha: string, width: number, format: string): string {
  return `blobs/${sha}/w${width}.${format}`;
}

export function treeKey(treeSha: string): string {
  return `trees/${treeSha}.json`;
}

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Range, If-Range, If-None-Match',
  // `Range` is in the allowed list above, so the range headers belong in this
  // one: a cross-origin reader that cannot see `Content-Range` or
  // `Accept-Ranges` cannot tell a 206 apart from a truncated 200.
  'Access-Control-Expose-Headers':
    'Content-Type, Content-Length, ETag, Accept-Ranges, Content-Range',
  'Access-Control-Max-Age': '86400',
};

/**
 * Production serves from content.classmoji.io, which sits inside the app's
 * `.classmoji.io` session-cookie domain. Without this, an SVG carrying inline
 * script — opened as a top-level navigation rather than through <img> — would
 * execute on that domain. `sandbox` drops the response into an opaque origin
 * with no script execution; subresource use (<img>, <link rel=stylesheet>,
 * fonts) is untouched, because those never run script in the first place.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

/**
 * Applied to every response leaving the Worker: CORS, nosniff, the sandboxing
 * CSP, and a hard guarantee that no cookie is ever set on a content domain.
 */
export function finalizeHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.delete('Set-Cookie');
  return headers;
}

/**
 * The same response with its body dropped — what a HEAD gets.
 *
 * The body is cancelled rather than abandoned: on the origin path it is one
 * half of a `tee()`, and a branch nobody reads eventually stalls the branch on
 * its way to R2.
 */
export function withoutBody(response: Response): Response {
  // Swallowed, not ignored: cancelling a tee'd branch whose partner already
  // errored rejects, and an unhandled rejection here would take down a request
  // that has otherwise succeeded.
  response.body?.cancel().catch(() => {});
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function finalize(response: Response): Response {
  const headers = finalizeHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Short TTL for a response we are willing to serve but must not pin: a
 * transform that fell back to the original, for instance.
 */
export const SHORT_CACHE_CONTROL = 'public, max-age=60';

export function contentHeaders(
  contentType: string,
  cacheControl: string,
  extra?: HeadersInit
): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', cacheControl);
  // `fmt=auto` picks avif or webp from Accept, and the answer is cached
  // immutable for up to 30 days. Without this the first Chrome visitor pins
  // AVIF bytes under the URL for every Safari visitor after them. Set
  // unconditionally — the header is static, so it costs nothing.
  headers.set('Vary', 'Accept');
  return finalizeHeaders(headers);
}

/**
 * Headers for a reply that carries object bytes, as opposed to JSON or an error.
 *
 * `contentHeaders` plus `Accept-Ranges: bytes`. The line is drawn there on
 * purpose: advertising range support on a 403 or on `/healthz` would be noise,
 * and a client that never sees `Accept-Ranges` on the object itself has no way
 * to know it may seek — which is the whole reason Chrome's `<video>` element
 * gave up on these URLs.
 *
 * Every byte-carrying reply gets it, including the image-variant path, which
 * then ignores any `Range` it is sent and answers a full 200. That is
 * deliberate and RFC 7233 §3.1 permits it: variants are raster images, the only
 * clients that seek are media players, and no media player ever asks for a
 * `?w=800&fmt=webp` URL.
 */
export function blobHeaders(
  contentType: string,
  cacheControl: string,
  extra?: HeadersInit
): Headers {
  const headers = contentHeaders(contentType, cacheControl, extra);
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

export function jsonResponse(body: unknown, status: number, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: contentHeaders('application/json; charset=utf-8', cacheControl),
  });
}

export function errorResponse(status: number, error: string): Response {
  return jsonResponse({ error }, status, 'no-store');
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: finalizeHeaders(new Headers()) });
}
