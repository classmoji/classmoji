import type { FrameHosts } from '~/components/editor/blocks/safeFrame.ts';

/**
 * Our own hosts for this deployment, as the frame rule reads them
 * (`decideFrame` in `components/editor/blocks/safeFrame.ts`):
 *
 *   - `hosts`, never framed: the web app (`WEBAPP_URL`), this pages app
 *     (`PAGES_URL`) and the content delivery origin (`CONTENT_DELIVERY_ORIGIN`;
 *     a file of the class's own is the one exception);
 *   - `siteDomain`: the class sites' base domain (`SITE_BASE_DOMAIN`). Every
 *     strict subdomain of it is a class site, or another host of ours, and is
 *     never framed; the base domain itself (the marketing and docs site) is
 *     framed unless it is one of `hosts`;
 *   - `framed`: the slides app (`SLIDES_URL`), framed like any other site even
 *     when it is a subdomain of the base domain (a deck embedded in a page);
 *   - `delivery`: the content delivery origin's hostname, or null.
 *
 * Read from the environment at call time (a hot-reloaded dev server keeps no
 * stale copy), here rather than through `site/env.server.ts`, so the page
 * loader does not pull the site's service imports in with it. An unset or
 * malformed value names no host. A class site's custom domain is not listed
 * (no list of them is at hand when a page is read); the page's own origin,
 * which is the custom domain on one, is refused by the client itself.
 */
export function ownFrameHosts(env: NodeJS.ProcessEnv = process.env): FrameHosts {
  const hostOf = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
      return host || null;
    } catch {
      return null;
    }
  };
  const hosts = new Set<string>();
  for (const value of [env.WEBAPP_URL, env.PAGES_URL, env.CONTENT_DELIVERY_ORIGIN]) {
    const host = hostOf(value);
    if (host) hosts.add(host);
  }
  const slides = hostOf(env.SLIDES_URL);
  // The same reading as `siteBaseDomain()` (`@classmoji/services`): trimmed, lower case.
  const base = (env.SITE_BASE_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  return {
    hosts: [...hosts].sort(),
    siteDomain: base || null,
    // A slides host that is also a refused app host stays refused.
    framed: slides && !hosts.has(slides) ? [slides] : [],
    delivery: hostOf(env.CONTENT_DELIVERY_ORIGIN),
  };
}
