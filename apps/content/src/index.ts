/**
 * classmoji content delivery Worker.
 *
 * A cache with a pluggable origin, and nothing more. It verifies a signed URL,
 * serves the bytes from R2 when they are there, and otherwise pulls them from
 * the origin (GitHub, via a token the webapp mints) on the way to the browser.
 * It knows no business rules, holds no session, and knows nothing about a
 * classroom beyond the id in the URL.
 *
 *   GET /c/{classroomId}/blob/{sha}.{ext}?p=&v=&exp=&sig=[&w=&fmt=]
 *   GET /c/{classroomId}/theme/{theme}/{treeSha}/{p}.{v}.{exp}.{sig}/{relPath}
 *   GET /healthz
 *   OPTIONS *
 */
import { serveBlob } from './blob.ts';
import { errorResponse, jsonResponse, preflightResponse, withoutBody } from './cache.ts';
import { isConfigured, type Env } from './env.ts';
import { OriginError } from './origins/types.ts';
import { serveTheme } from './theme.ts';
import { parseContentUrl, verifyContentUrl } from './verify.ts';

/**
 * `/c/{classroomId}/missing/{encodedRepoPath}` — the deterministic URL the
 * app's resolver mints for a reference it cannot resolve (see `missingUrl` in
 * `contentDelivery.service.ts`). It carries no signature and never will, so it
 * is routed before verification and answered 404: a file that was deleted or
 * renamed is not a tampered URL, and the two must not share a log line. Every
 * OTHER unknown third segment stays a 403 — an unrecognized shape is exactly
 * what tampering looks like.
 */
const MISSING_PATH =
  /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/missing\/(.+)$/;

/** Best-effort decode for the log line only; a bad escape logs the raw segment. */
function decodeForLog(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The whole request, minus the one guarantee applied to its answer.
 *
 * A HEAD is answered from R2 metadata wherever the object is already there
 * (see `serveBlobBySha`); when it is not, it falls through to the full path so
 * the cache warms — and `withoutBody` in the caller is what keeps that
 * fall-through from putting bytes on the wire.
 */
async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') return preflightResponse();

  const url = new URL(request.url);

  if (url.pathname === '/healthz') {
    return jsonResponse(
      { ok: true, environment: env.ENVIRONMENT ?? 'unknown', configured: isConfigured(env) },
      200
    );
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'method not allowed');
  }

  if (!url.pathname.startsWith('/c/')) return errorResponse(404, 'not found');

  const missing = MISSING_PATH.exec(url.pathname);
  if (missing) {
    // The repo path is the app's own reference, not a credential — but the
    // query string still never reaches a log.
    console.warn(`[content] 404 missing classroom=${missing[1]} path=${decodeForLog(missing[2])}`);
    return errorResponse(404, 'missing');
  }

  const signingSecret = env.CONTENT_SIGNING_SECRET;
  if (!signingSecret || !env.CONTENT_WORKER_SHARED_SECRET || !env.CONTENT_TOKEN_ENDPOINT) {
    return errorResponse(503, 'not configured');
  }

  const verified = await verifyContentUrl(signingSecret, request.url);
  if (!verified.ok) {
    // Structural parse only (no crypto) - just to recover the classroom id
    // for a URL whose signature we don't yet trust. Never log `sig`, the
    // query string, or the full URL: those can leak a valid credential.
    const classroomId = parseContentUrl(request.url)?.classroomId ?? 'unknown';
    const p = url.searchParams.get('p');
    const v = url.searchParams.get('v');
    let message = `[content] 403 ${verified.reason} classroom=${classroomId} path=${url.pathname}`;
    if (p !== null) message += ` p=${p}`;
    if (v !== null) message += ` v=${v}`;
    console.warn(message);
    return errorResponse(403, verified.reason);
  }

  try {
    return verified.kind === 'blob'
      ? await serveBlob(env, ctx, request, verified)
      : await serveTheme(env, ctx, verified, request.method === 'HEAD');
  } catch (error) {
    if (error instanceof OriginError) {
      console.warn('[content] origin error:', error.message);
      return errorResponse(502, 'origin unavailable');
    }
    console.error('[content] unhandled error:', error);
    return errorResponse(500, 'internal error');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handle(request, env, ctx);
    // One place decides that a HEAD carries no body — every route included.
    return request.method === 'HEAD' ? withoutBody(response) : response;
  },
} satisfies ExportedHandler<Env>;
