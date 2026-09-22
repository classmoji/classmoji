/**
 * The handful of environment values the class-site routes need, read in ONE
 * place so no loader has to remember a fallback.
 *
 * Read at call time, never at module load: the dev stack hot-reloads app files
 * without restarting the process, and a module-level snapshot would pin a stale
 * value for the life of the server.
 */

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/** The Classmoji webapp (sign-in, dashboards, member-only resources). */
export function webappUrl(): string {
  return trimSlash(process.env.WEBAPP_URL || 'http://localhost:3000');
}

/** The canonical pages host (the editor) — also the "Edit page" link target. */
export function pagesUrl(): string {
  return trimSlash(process.env.PAGES_URL || 'http://localhost:7100');
}

/** The slides app (schedule items of type SLIDE link here). */
export function slidesUrl(): string {
  return trimSlash(process.env.SLIDES_URL || 'http://localhost:6500');
}

/**
 * The three site-hostname builders now live in `@classmoji/services`
 * (`classmoji/siteLinks.ts`) and are re-exported here under the names this app
 * already imports.
 *
 * They moved because the webapp's forms list has to copy the SAME public form
 * link this app's list copies, and that link is built out of these. They read
 * PAGES_URL and SITE_BASE_DOMAIN at call time exactly as they did here.
 */
export { siteBaseDomain, siteOrigin, customDomainOrigin } from '@classmoji/services';

/**
 * Origins allowed to frame a site page (`frame-ancestors`).
 *
 * The webapp and the editor host embed site pages in preview panels, and the
 * slide viewer embeds them inside decks. Tenant origins are deliberately NOT
 * included: `*.classmoji.io` would let any instructor's site frame any other's,
 * which is the setup for a clickjacking proxy between two courses. The three
 * hosts here are all ours.
 */
export function frameAncestorOrigins(): string[] {
  const origins = new Set<string>();
  for (const url of [webappUrl(), pagesUrl(), slidesUrl()]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Skip a malformed value rather than emitting a broken CSP token.
    }
  }
  return [...origins];
}
