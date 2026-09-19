/**
 * Cross-site request rejection for the forms submission endpoints.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The magic link authenticates a PUBLIC submission, but nothing authenticates
 * the request that ASKS for a link: a cross-site form post can make a visitor's
 * browser mail a stranger a link, and a CLASSROOM submit rides the visitor's own
 * session cookie, which is textbook CSRF. React Router ships no document-CSRF
 * check to lean on, so the origin is checked here, in one place both the public
 * fill action and (mission 6) the classroom submit action call.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *  1. `Origin` present  → it MUST equal this request's own origin. Browsers set
 *     it on every cross-origin POST, so this is the case that actually matters
 *     and it is decided on a header the page under attack cannot forge.
 *  2. `Origin` absent, `Sec-Fetch-Site` present → allow only `same-origin` /
 *     `same-site` / `none` (`none` is a user-typed URL or a bookmark). `cross-
 *     site` is refused. Every browser that omits Origin on a form post sends
 *     this instead, so the pair covers the real client population.
 *  3. Neither header → allow. This is a non-browser client (curl, a Playwright
 *     API request, a health probe), which has no ambient cookie to abuse and
 *     therefore nothing to confuse: CSRF is an attack on a browser's willingness
 *     to attach credentials it already holds, and a bare HTTP client attaches
 *     nothing it was not explicitly given.
 *
 * Rule 3 is the one that looks like a hole and is not. Deciding it the other way
 * would refuse every scripted client while stopping no attack a browser can
 * mount — no browser reaches case 3.
 *
 * `X-Forwarded-Host` is deliberately NOT consulted. Behind Fly the app sees the
 * proxy's forwarded values, and `request.url` is already built from them by the
 * server adapter; reading the header again here would let a client that can set
 * it name its own expected origin, which is the whole check inverted.
 */

/** Why a request was refused. Callers log this; users never see it. */
export type OriginRejection = 'origin-mismatch' | 'cross-site-fetch';

export interface OriginCheckResult {
  ok: boolean;
  reason?: OriginRejection;
  /** The offending `Origin`, for the server log. Never echoed to the client. */
  origin?: string;
}

/** Values of `Sec-Fetch-Site` that are not a cross-site navigation or post. */
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'same-site', 'none']);

/**
 * Is this request same-origin enough to be allowed to mutate?
 *
 * Returns a result rather than throwing so the caller decides the response
 * shape: a fill action wants to re-render its own page with a neutral error, not
 * escalate to the route ErrorBoundary.
 */
export function checkOrigin(request: Request): OriginCheckResult {
  const origin = request.headers.get('origin');

  if (origin) {
    // `Origin: null` is what a sandboxed iframe or a redirected cross-origin
    // post sends. It is not this origin, so it falls to the mismatch branch —
    // which is correct, and worth stating because `new URL('null')` throwing
    // would otherwise be an accident waiting to become a 500.
    let expected: string;
    try {
      expected = new URL(request.url).origin;
    } catch {
      return { ok: false, reason: 'origin-mismatch', origin };
    }
    if (origin !== expected) {
      return { ok: false, reason: 'origin-mismatch', origin };
    }
    return { ok: true };
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return { ok: false, reason: 'cross-site-fetch', origin: fetchSite };
  }

  return { ok: true };
}

/**
 * The largest request body a form submission may carry, in bytes.
 *
 * The contract already caps a stored answer set at 256KB, but that cap is
 * enforced by `parseAnswers` AFTER the body has been read into memory and JSON-
 * parsed. This is the cap before that work happens — a submission endpoint open
 * to anonymous callers must be able to refuse a 50MB post without deserializing
 * it. The extra headroom over the answers cap is the envelope: field names,
 * identity, the revision id, and form-encoding overhead.
 */
export const MAX_SUBMISSION_BYTES = 300 * 1024;

/**
 * Read a request body as text, refusing anything over the cap.
 *
 * `Content-Length` is checked first because it lets an oversized post be
 * rejected without reading it at all — but it is a client-supplied number, so
 * the actual decoded length is checked again afterwards. A body that lies about
 * its length is refused on the second check.
 *
 * Returns `null` when the body is too large; the caller answers 413.
 */
export async function readCappedBody(
  request: Request,
  limit: number = MAX_SUBMISSION_BYTES
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = await request.text();
  if (new TextEncoder().encode(body).length > limit) return null;
  return body;
}
