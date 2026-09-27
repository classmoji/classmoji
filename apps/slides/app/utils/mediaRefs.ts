/**
 * mediaRefs.ts — `media://{uuid}` in a rendered deck, without the database.
 *
 * Pure, with no imports at all, so the server's read paths and the browser can
 * both use it and the client bundle never picks up anything else through it.
 *
 * A `media://` reference is what a deck STORES for a file in the classroom's
 * media. No browser can load that scheme: every read surface turns it into a
 * signed URL, or into the resolver's placeholder when the layer cannot sign.
 * `stripMediaRefs` is the last line for the paths where neither happened — a
 * resolver that failed, or the viewer's client-side fallback that reads the
 * stored index.html directly — so the reference never reaches the DOM.
 *
 * READ SURFACES ONLY. The editor keeps its references: a document that goes back
 * through a save must carry what it loaded, and `about:blank` in its place would
 * be committed as the new source.
 */

/** Every `media://{uuid}` in a string. Case-insensitive, like the ids a browser may hand back. */
const MEDIA_REF_IN_TEXT =
  /media:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** What stands in for a media reference that has no URL. Never `media://`. */
export const NO_MEDIA_URL = 'about:blank';

/**
 * The html with every `media://{uuid}` replaced by `about:blank`.
 *
 * A plain text pass: a reference in an attribute, in inline css or in a
 * `srcset` is replaced wherever it sits.
 */
export function stripMediaRefs(html: string): string;
export function stripMediaRefs(html: string | null): string | null;
export function stripMediaRefs(html: string | null): string | null {
  if (!html) return html;
  return html.replace(MEDIA_REF_IN_TEXT, NO_MEDIA_URL);
}
