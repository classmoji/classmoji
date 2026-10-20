/**
 * Cross-site request rejection for the webapp's JSON POST endpoints (the Ask
 * Moji routes first). The pages app's `checkOrigin` (apps/pages/app/utils/
 * originCheck.server.ts) is the pattern; the one difference is which origins
 * count as "this app".
 *
 * ── Why two expected origins ──────────────────────────────────────────────
 * The webapp runs under `react-router-serve` without `trust proxy`, so behind
 * Fly's TLS-terminating proxy `request.url` is built as `http://<host>/…`
 * while the browser sends `Origin: https://<host>`. Comparing against
 * `request.url` alone would refuse every production POST. So the expected set
 * is the configured `WEBAPP_URL` origin (trusted env, the address users load)
 * plus the request's own origin (development, where the two agree and
 * `WEBAPP_URL` may be unset). `X-Forwarded-*` headers are never consulted: a
 * client that can set them would name its own expected origin.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *  1. `Origin` present → it must be one of the expected origins. `Origin: null`
 *     (a sandboxed frame, a redirected post) is not, so it is refused.
 *  2. `Origin` absent, `Sec-Fetch-Site` present → only `same-origin`,
 *     `same-site` or `none`.
 *  3. Neither header → allowed: not a browser, so no ambient cookie to abuse.
 */

export type OriginRejection = 'origin-mismatch' | 'cross-site-fetch';

export interface OriginCheckResult {
  ok: boolean;
  reason?: OriginRejection;
  /** The offending value, for the server log only. */
  origin?: string;
}

const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'same-site', 'none']);

/** The origin of a URL string, or null when it is missing or not http(s). */
export function originOf(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The origins a same-app request may carry. */
export function expectedOrigins(
  request: Request,
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const out = new Set<string>();
  const configured = originOf(env.WEBAPP_URL);
  if (configured) out.add(configured);
  const own = originOf(request.url);
  if (own) out.add(own);
  return out;
}

export function checkOrigin(
  request: Request,
  env: Record<string, string | undefined> = process.env
): OriginCheckResult {
  const origin = request.headers.get('origin');
  if (origin) {
    return expectedOrigins(request, env).has(origin)
      ? { ok: true }
      : { ok: false, reason: 'origin-mismatch', origin };
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return { ok: false, reason: 'cross-site-fetch', origin: fetchSite };
  }
  return { ok: true };
}
