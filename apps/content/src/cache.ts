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
  'Access-Control-Allow-Headers': 'Accept, Range, If-None-Match',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag',
  'Access-Control-Max-Age': '86400',
};

/**
 * Applied to every response leaving the Worker: CORS, nosniff, and a hard
 * guarantee that no cookie is ever set on a content domain.
 */
export function finalizeHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Set-Cookie');
  return headers;
}

export function finalize(response: Response): Response {
  const headers = finalizeHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function contentHeaders(
  contentType: string,
  cacheControl: string,
  extra?: HeadersInit
): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', cacheControl);
  return finalizeHeaders(headers);
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
