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

/**
 * An app connection started while signed out sends the browser here with the
 * authorization's signed query in the address, and the auth client sends it
 * with every request (`oauthProviderClient`, @classmoji/auth/client) so the
 * sign-in resumes the authorization. The signed query expires
 * (@better-auth/oauth-provider's `codeExpiresIn`, 10 minutes); after that the
 * auth server refuses any request that carries it with
 * `{ error: 'invalid_signature' }`, the sign-in included.
 */
export function isExpiredAppConnection(error: unknown): boolean {
  return (error as { error?: unknown } | null | undefined)?.error === 'invalid_signature';
}

/** What the sign-in page says when that happens. */
export const EXPIRED_APP_CONNECTION_MESSAGE =
  'Please sign in again, then connect the app again from where you started.';

/**
 * Takes the authorization's signed query out of the address (the parameters
 * it names in `ba_param`, plus `sig` and `ba_param`), keeping the page's own
 * parameters, so the next attempt signs in without it.
 */
export function dropAppConnectionQuery(): void {
  const url = new URL(window.location.href);
  const signed = new Set([...url.searchParams.getAll('ba_param'), 'ba_param', 'sig']);
  for (const name of signed) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url.toString());
}
