/**
 * deckThumbnail.contract.ts — the handful of facts the render route and the
 * render task must agree on, in one place because they cannot import each
 * other.
 *
 * The route lives in the slides app and the task in `@classmoji/tasks`; both
 * depend on this package and neither depends on the other. Left as two copies,
 * the readiness selector is the one that silently breaks everything: the page
 * would raise an attribute nobody waits for, `waitForSelector` would time out,
 * and every render would fail with an error that names neither half.
 *
 * Geometry: 1280×720 at `deviceScaleFactor: 1`. The index card is `aspect-video`
 * and ~400px wide on a three-column grid, so 16:9 drops in with no letterboxing
 * and ~3× oversampling — enough for a 2× display and for a wider card later.
 */

/** Viewport Browser Run renders at, and the box the route lays out for. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/** WebP quality. ~40-70 KB per deck, against ~150 KB for the same frame as PNG. */
export const THUMBNAIL_WEBP_QUALITY = 80;

/**
 * The attribute the render page raises once it has painted, and the selector
 * Browser Run waits for.
 *
 * It is what stops an error page or a 403 being screenshotted and committed as
 * a deck's thumbnail: the attribute only ever appears on a page the route
 * actually served.
 */
export const THUMBNAIL_READY_ATTRIBUTE = 'data-thumbnail-ready';
export const THUMBNAIL_READY_SELECTOR = `[${THUMBNAIL_READY_ATTRIBUTE}]`;

/** Filename committed beside the deck's own files, inside `content_path`. */
export const THUMBNAIL_FILENAME = 'thumbnail.webp';

/** Repo-relative path for a deck's thumbnail: `slides/<slug>/thumbnail.webp`. */
export function thumbnailPathFor(contentPath: string): string {
  return `${contentPath.replace(/\/+$/, '')}/${THUMBNAIL_FILENAME}`;
}

/**
 * The cookie the render token travels in, and the ONLY channel the route reads.
 *
 * It has had three homes, and the reasoning for each move is worth keeping:
 *
 *   - `?render=` in the QUERY STRING. The obvious shape for a "navigate to this
 *     URL" API, and the wrong one for a credential: a query string is written
 *     to every access log in the path (this app's own `morgan` line included),
 *     kept in proxy caches, and handed on in a `Referer`.
 *   - `X-Render-Token` as a REQUEST HEADER. Out of the logs — but Puppeteer's
 *     `setExtraHTTPHeaders` applies to every request the PAGE makes, so a
 *     deck's images carried the live token to `*.github.io` and to the content
 *     Worker. Host-bound or not, that is our credential in a third party's
 *     logs.
 *   - a COOKIE, which is what this is. Cookies are HOST-SCOPED by the browser
 *     itself: `cm_render` is set for the render host and no cross-host
 *     subresource can ever receive it. Same-origin asset fetches do carry it,
 *     and that origin is ours.
 *
 * `httpOnly` and `secure` because there is no reason for anything in the page
 * to read it and no reason for it to travel in clear; `sameSite: 'Strict'`
 * because the only navigation that should present it is the one Browser Run
 * makes itself.
 */
export const RENDER_TOKEN_COOKIE = 'cm_render';

/** The Puppeteer `setCookie` descriptor Browser Run's `cookies` array takes. */
export interface RenderTokenCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict';
}

/**
 * The one cookie the screenshot request carries.
 *
 * `domain` is the render HOST, not the origin — a cookie domain has no scheme
 * and no port, and handing CDP one with either produces a cookie the browser
 * never sends. `secure: true` is safe on a local `http://localhost` render too:
 * browsers treat localhost as a trustworthy origin and send Secure cookies to
 * it.
 */
export function renderTokenCookie(origin: string, token: string): RenderTokenCookie {
  return {
    name: RENDER_TOKEN_COOKIE,
    value: token,
    domain: new URL(origin).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  };
}

/**
 * The URL Browser Run is pointed at. No credential in it, by design — see
 * `RENDER_TOKEN_COOKIE`.
 */
export function thumbnailSourceUrl(origin: string, slideId: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/${slideId}/thumbnail-source`;
}
