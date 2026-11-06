/**
 * Whether a successful auth response already sends the browser somewhere.
 *
 * better-auth's client follows a `{ redirect: true, url }` response by itself:
 * its built-in redirect fetch plugin sets `window.location.href` to `url`
 * (better-auth `client/fetch-plugins`). Email sign-in answers that way for the
 * `callbackURL` it was given, and an auth server continuing an app connection
 * (an authorization started while signed out) answers that way for the
 * consent page. Navigating to `callbackURL` afterwards would replace the
 * server's choice, so the sign-in page does so only when this is false.
 */
export function authServerRedirects(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const { redirect, url } = data as { redirect?: unknown; url?: unknown };
  return redirect === true && typeof url === 'string' && url.length > 0;
}
