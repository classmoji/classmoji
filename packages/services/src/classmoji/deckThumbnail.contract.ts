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
 * The URL Browser Run is pointed at.
 *
 * The token goes in the query string because that is the only channel a
 * screenshot request has — Browser Run navigates, it does not carry headers we
 * choose per-request. The route answers `no-store` and `noindex` precisely
 * because of that.
 */
export function thumbnailSourceUrl(origin: string, slideId: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/${slideId}/thumbnail-source?render=${encodeURIComponent(token)}`;
}
