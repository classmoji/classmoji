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
import { isConfigured, signingSecrets, type Env } from './env.ts';
import { OriginError } from './origins/types.ts';
import { serveTheme } from './theme.ts';
import { isClassroomId, parseContentUrl, verifyContentUrl } from './verify.ts';

/**
 * `/c/{classroomId}/missing/{encodedRepoPath}` — the deterministic URL the
 * app's resolver mints for a reference it cannot resolve (see `missingUrl` in
 * `contentDelivery.service.ts`). It carries no signature and never will, so it
 * is routed before verification and answered 404: a file that was deleted or
 * renamed is not a tampered URL, and the two must not share a log line. Every
 * OTHER unknown third segment stays a 403 — an unrecognized shape is exactly
 * what tampering looks like.
 *
 * The classroom segment is captured loosely and then checked with the signing
 * package's own `isClassroomId`, so this and the verifier cannot drift apart on
 * what a classroom id is.
 */
const MISSING_PATH = /^\/c\/([^/]+)\/missing\/(.+)$/;

/** A repo path is the app's own string, but it arrives from the network. */
const MAX_LOGGED_PATH = 512;

/**
 * `classroomId|keyVersion` pairs already reported as still using the previous
 * signing key, so each one is logged once per isolate instead of once per
 * request.
 *
 * A rotation stays open for as long as the longest signature lives — 30 days
 * for the public tier — and a warn on every request for a month would bury the
 * 403 and 404 lines an operator actually searches for. The cost is that the
 * count is no longer traffic: it says which classrooms are still handing out
 * old URLs, not how often.
 */
const ROTATION_LOG_LIMIT = 512;
const rotationLogged = new Set<string>();

/** Test/ops hook: forget which rotations have already been reported. */
export function clearRotationLog(): void {
  rotationLogged.clear();
}

/** C0 controls, DEL, and the C1 block - everything a log line must not contain. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Make one untrusted segment safe to put in a log line.
 *
 * `url.pathname` keeps its percent-escapes, so decoding is what turns `%0A`
 * into a real newline — and a newline in `console.warn` is a whole forged
 * entry. An unauthenticated request could otherwise write a convincing
 * `[content] 403 bad-signature classroom=…` line into the log an operator is
 * told to search. Every control character becomes U+FFFD, and the result is
 * capped so one request cannot flood the stream either.
 */
function decodeForLog(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }

  let safe = '';
  for (const char of decoded.slice(0, MAX_LOGGED_PATH)) {
    safe += isControl(char.codePointAt(0) ?? 0) ? '\uFFFD' : char;
  }
  return safe;
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
  if (missing && isClassroomId(missing[1])) {
    // The repo path is the app's own reference, not a credential — but the
    // query string still never reaches a log.
    console.warn(`[content] 404 missing classroom=${missing[1]} path=${decodeForLog(missing[2])}`);
    return errorResponse(404, 'missing');
  }

  // One definition of "configured", shared with /healthz — the verifier below
  // needs no narrowed local now that it takes the whole list of secrets.
  if (!isConfigured(env)) return errorResponse(503, 'not configured');

  const verified = await verifyContentUrl(signingSecrets(env), request.url);
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

  // Rotation telemetry: which classrooms are still serving URLs minted under
  // the old key. Once per classroom and key version per isolate — see
  // `rotationLogged`. Carries no signature and no query string, for the same
  // reason the 403 line above does not.
  if (verified.keySlot === 'previous') {
    const rotation = `${verified.classroomId}|${verified.keyVersion}`;
    if (!rotationLogged.has(rotation)) {
      // Bounded: an isolate that has seen this many distinct pairs starts a
      // fresh window rather than growing without limit.
      if (rotationLogged.size >= ROTATION_LOG_LIMIT) rotationLogged.clear();
      rotationLogged.add(rotation);
      console.warn(
        `[content] key=previous classroom=${verified.classroomId} path=${url.pathname}` +
          ` p=${verified.tier} v=${verified.keyVersion}`
      );
    }
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
