import { useEffect } from 'react';

/**
 * Tell the pages app where a reader came from, so its top bar can send them
 * back there (rather than to the class dashboard).
 *
 * Links into the pages app open in a new tab, usually with `rel="noreferrer"`,
 * so the pages tab has neither a referrer nor any history to go back through.
 * Instead, at the moment a link to the pages host is followed, this adds
 * `?from=<the webapp path the reader is on>` to it. The pages app keeps it for
 * that tab and links its class name back to it; it only accepts a path of the
 * same classroom (see `cameFromPath` in apps/pages). A link nothing clicked
 * (copied, bookmarked) carries no `from` and falls back to the dashboard.
 *
 * One listener in the capture phase, so every link to the pages host is
 * covered (module rows, calendar, materials, the reader drawer's open-in-new
 * button) without each building its own URL. Capture runs before the browser's
 * default action, so the rewritten href is the one followed, for a plain click,
 * a modifier click (`click`) and a middle click (`auxclick`).
 */

export const PAGES_FROM_PARAM = 'from';

/**
 * `href` with `from` set, when it points at the pages host; otherwise null.
 * Pure, for tests: the hook calls it with the live location.
 */
export function pagesHrefWithFrom(href: string, pagesOrigin: string, from: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== pagesOrigin) return null;
  // Forms (`/{slug}/forms/...`) have no top bar to use it, and no layout that
  // would take it back out of the address bar.
  if (url.pathname.split('/')[2] === 'forms') return null;
  url.searchParams.set(PAGES_FROM_PARAM, from);
  return url.toString();
}

/** The origin of the pages app URL, or null when it is unset or malformed. */
export function pagesOriginOf(pagesUrl: string | null | undefined): string | null {
  if (!pagesUrl) return null;
  try {
    return new URL(pagesUrl).origin;
  } catch {
    return null;
  }
}

export function usePagesFromParam(pagesUrl: string | null | undefined): void {
  useEffect(() => {
    const pagesOrigin = pagesOriginOf(pagesUrl);
    if (!pagesOrigin || typeof document === 'undefined') return;

    const tag = (event: MouseEvent) => {
      // A right click opens the context menu, not the link: leave it alone so
      // "Copy link address" copies the plain link.
      if (event.button === 2) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const from = `${window.location.pathname}${window.location.search}`;
      const original = anchor.href;
      const next = pagesHrefWithFrom(original, pagesOrigin, from);
      if (!next || next === original) return;
      anchor.href = next;
      // Only this navigation carries it: the browser has already taken the href
      // by the next task, so put the plain link back for copying and hovering.
      window.setTimeout(() => {
        if (anchor.href === next) anchor.href = original;
      }, 0);
    };

    document.addEventListener('click', tag, true);
    document.addEventListener('auxclick', tag, true);
    return () => {
      document.removeEventListener('click', tag, true);
      document.removeEventListener('auxclick', tag, true);
    };
  }, [pagesUrl]);
}
