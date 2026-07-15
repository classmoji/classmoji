/**
 * Shared validation for OAuth redirect targets.
 *
 * Guards the open-redirect -> XSS vector on the MCP OAuth flow: a maliciously
 * registered client could set a `javascript:` / `data:` redirect_uri that later
 * gets handed back to the consent screen and executed via
 * `window.location.href`, running attacker JS in our authenticated origin.
 * Only absolute http(s) targets are ever considered safe.
 *
 * Used both at the root cause (Dynamic Client Registration in
 * `routes/api.auth.$.ts`) and at the sink (`routes/oauth.consent/route.tsx`).
 */

/** True only when `target` parses as an absolute http(s) URL. */
export function isHttpRedirectUri(target: unknown): target is string {
  if (typeof target !== 'string') return false;
  try {
    const { protocol } = new URL(target);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    // Not an absolute, parseable URL (or a non-http scheme like javascript:).
    return false;
  }
}
