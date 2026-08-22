/**
 * The /site-return decision tree, as pure functions.
 *
 * The route loader is deliberately thin glue around these: everything worth
 * testing here is a branch on (token, session, site row, environment), and none
 * of it wants a database or a Request to exercise.
 *
 * Split in two because the site lookup sits in the middle — `planSiteReturn`
 * decides whether we even have a classroom to look up, `resolveSiteDestination`
 * turns what came back into a destination.
 */

import { isSafeRelativePath, verifySiteReturnToken } from '@classmoji/auth/site-return';
import { isValidSubdomain, normalizeSubdomain } from '@classmoji/utils';

/** A bare lowercase domain: two or more DNS labels, no scheme/port/path. */
const BARE_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Longest `?redirect=` value the sign-in page will carry back here. */
export const MAX_RETURN_PATH_LENGTH = 1024;

export type SiteReturnPlan =
  /** Token missing, tampered, or expired. Render the friendly 400. */
  | { action: 'invalid-token' }
  /** Valid token, no session. Bounce through sign-in and come back. */
  | { action: 'sign-in'; redirectTo: string }
  /** Valid token and a session — go read the site row for this classroom. */
  | { action: 'lookup'; classroomId: string; path: string };

export type SiteReturnDestination =
  /** No site row, site switched off, or the platform is not configured for sites. */
  | { action: 'site-unavailable' }
  /** Send the (now signed-in) visitor back where they started. */
  | { action: 'return'; url: string };

/** The slice of the environment this module reads (structurally `process.env`). */
export interface SiteReturnEnv {
  SITE_BASE_DOMAIN?: string | undefined;
  PAGES_URL?: string | undefined;
  NODE_ENV?: string | undefined;
  [key: string]: string | undefined;
}

/** The two fields of a ClassroomSite row this decision needs. */
export interface SiteRowForReturn {
  subdomain: string;
  is_enabled: boolean;
}

/**
 * Decide what to do with an arriving token, before touching the database.
 *
 * Order matters and is not negotiable: the token is verified FIRST, so an
 * unauthenticated visitor is never sent through an OAuth round-trip on the
 * strength of a link we cannot vouch for — and so `redirectTo` is only ever
 * built from a string we minted ourselves.
 */
export function planSiteReturn(rawToken: string | null, isSignedIn: boolean): SiteReturnPlan {
  const payload = verifySiteReturnToken(rawToken);
  if (!payload) return { action: 'invalid-token' };

  if (!isSignedIn) {
    // Relative on purpose. The landing page honours `?redirect=` for relative
    // paths only; the token is the one and only cross-origin mechanism.
    const returnTo = `/site-return?token=${encodeURIComponent(rawToken as string)}`;
    if (!isSafeRelativePath(returnTo, MAX_RETURN_PATH_LENGTH)) {
      // Only reachable if a token ever grew past what the landing page accepts.
      // Fail to the friendly error rather than dropping them somewhere random.
      return { action: 'invalid-token' };
    }
    return { action: 'sign-in', redirectTo: `/?redirect=${encodeURIComponent(returnTo)}` };
  }

  return { action: 'lookup', classroomId: payload.classroomId, path: payload.path };
}

/**
 * The origin a course site is served from, or null when it cannot be built.
 *
 * Production is `https://{subdomain}.{SITE_BASE_DOMAIN}`; anywhere else the
 * pages app answers on a port, which is read off PAGES_URL (devports move it
 * per worktree, so it can never be hardcoded).
 *
 * Returns null — never a partial URL — when SITE_BASE_DOMAIN is unset or
 * malformed, or the subdomain is not a DNS label. This function's output goes
 * straight into a `Location` header, so "fail closed" is the whole contract.
 */
export function resolveSiteOrigin(subdomain: string, env: SiteReturnEnv): string | null {
  const label = normalizeSubdomain(subdomain);
  if (!isValidSubdomain(label)) return null;

  const baseDomain = String(env.SITE_BASE_DOMAIN ?? '')
    .trim()
    .toLowerCase();
  if (!baseDomain || !BARE_DOMAIN.test(baseDomain)) return null;

  if (env.NODE_ENV === 'production') return `https://${label}.${baseDomain}`;

  return `http://${label}.${baseDomain}${devPortSuffix(env.PAGES_URL)}`;
}

/** `:7140` from `http://localhost:7140`, or '' when there is no port to add. */
function devPortSuffix(pagesUrl: string | undefined): string {
  const raw = String(pagesUrl ?? '').trim();
  if (!raw) return '';
  try {
    const port = new URL(raw).port;
    return port ? `:${port}` : '';
  } catch {
    return '';
  }
}

/**
 * Turn the freshly-read site row into a destination.
 *
 * `is_enabled` is the ONLY site flag consulted. Archived classrooms, unpublished
 * ones and deleted home pages are the pages host's business — it classifies them
 * itself, with the right page for each. Duplicating that judgement here would
 * mean two places to keep in step and a visitor stranded on the webapp for a
 * condition the site can explain better.
 *
 * Membership is likewise NOT checked: a signed-in non-member is returned to the
 * site, which renders its own anonymous view. The token only ever proved that
 * the sign-in intent came from a real course site page.
 */
export function resolveSiteDestination(
  site: SiteRowForReturn | null,
  path: string,
  env: SiteReturnEnv
): SiteReturnDestination {
  if (!site || !site.is_enabled) return { action: 'site-unavailable' };

  const origin = resolveSiteOrigin(site.subdomain, env);
  if (!origin) return { action: 'site-unavailable' };

  // Re-validated at the sink. The path arrived inside a signed token and was
  // checked on the way in, but this concatenation is what a browser follows.
  if (!isSafeRelativePath(path)) return { action: 'site-unavailable' };

  return { action: 'return', url: `${origin}${path}` };
}
