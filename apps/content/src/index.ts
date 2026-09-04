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
import { errorResponse, jsonResponse, preflightResponse } from './cache.ts';
import { isConfigured, type Env } from './env.ts';
import { OriginError } from './origins/types.ts';
import { serveTheme } from './theme.ts';
import { parseContentUrl, verifyContentUrl } from './verify.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        : await serveTheme(env, ctx, verified);
    } catch (error) {
      if (error instanceof OriginError) {
        console.warn('[content] origin error:', error.message);
        return errorResponse(502, 'origin unavailable');
      }
      console.error('[content] unhandled error:', error);
      return errorResponse(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
