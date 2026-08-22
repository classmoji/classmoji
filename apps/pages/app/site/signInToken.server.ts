import { isSafeRelativePath, signSiteReturnToken } from '@classmoji/auth/site-return';

import { DEFAULT_RETURN_TO } from './returnTo.ts';

/**
 * Bridge to the webapp's signed site-return hand-off.
 *
 * A class site cannot simply send `?redirect={url}` to the webapp — that would
 * make every course subdomain an open-redirect source pointed at the app's
 * login flow. Instead the destination is HMAC'd with AUTH_SECRET here and
 * verified there, so the webapp only ever bounces to a path this server
 * actually vouched for.
 *
 * Two properties of that API shape the code below:
 *
 *  - `signSiteReturnToken` THROWS on a path it considers unsafe. On the one
 *    page whose entire job is to unstick a locked-out visitor, an unhandled
 *    throw would be a 500 — so the path is checked with the library's own
 *    `isSafeRelativePath` first, and anything it rejects silently degrades to
 *    `/` rather than failing.
 *  - Tokens live 5 minutes. They are minted per request, in the loader, and
 *    the interstitial is `no-store` — a cached page would eventually serve a
 *    token that has already expired, sending visitors to an error instead of
 *    a login.
 */

type SignInHandoff = {
  url: string;
  /** False when the token could not be minted and the link is the app's front door. */
  signed: boolean;
};

/**
 * The URL the interstitial's sign-in button points at.
 *
 * With a token: the webapp's `/site-return`, which signs the visitor in and
 * returns them to `path` on this site. Without one: the webapp's front door,
 * which still signs them in — they just land on their dashboard rather than
 * the page they clicked.
 */
export function signInHandoffUrl(
  webappBaseUrl: string,
  payload: { classroomId: string; path: string }
): SignInHandoff {
  const fallback = { url: `${webappBaseUrl}/`, signed: false };

  // `returnTo.ts` already sanitized this; re-checking with the auth package's
  // own predicate means the two never disagree about what "safe" means, and
  // it is that predicate — not ours — that the signer enforces.
  const path = isSafeRelativePath(payload.path) ? payload.path : DEFAULT_RETURN_TO;

  try {
    const token = signSiteReturnToken({ classroomId: payload.classroomId, path });
    return { url: `${webappBaseUrl}/site-return?token=${encodeURIComponent(token)}`, signed: true };
  } catch (error) {
    // A missing/short AUTH_SECRET is a deployment problem, not a reason to
    // 500 a public page.
    console.error('[site] Failed to sign site-return token:', error);
    return fallback;
  }
}
