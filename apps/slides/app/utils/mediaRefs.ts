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
 * `stripMediaRefs` is for READ SURFACES ONLY. The editor keeps its references: a
 * document that goes back through a save must carry what it loaded, and
 * `about:blank` in its place would be committed as the new source. The
 * editor's own helper here is `canonicalMediaUrls`, for its diff.
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

/** The host of a delivery origin (`https://content.classmoji.io` → the host), or null. */
export function deliveryHostOf(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The html with each signed media URL of OURS turned back into its
 * `media://{id}` reference — the editor's diff, not a save.
 *
 * The editor holds its media references signed (they have no proxy to load
 * through), and an edit-tier signature is minted fresh on every read: the one
 * in the DOM and the one in the document a save hands back differ even when
 * nothing was edited. Comparing them as written would read as an edit to every
 * slide with a video on it. Comparing by reference cannot.
 *
 * "Ours" is the delivery host AND this classroom — the same scoping the save
 * path's canonicalization uses. A URL of the same shape on any other host, or
 * for another classroom, is an author's content and is left exactly as it is.
 * No host (the deployment signs nothing) → the html comes back unchanged.
 */
export function canonicalMediaUrls(
  html: string,
  scope: { host: string | null | undefined; classroomId: string | null | undefined }
): string {
  const { host, classroomId } = scope;
  if (!html || !host || !classroomId) return html;
  const signed = new RegExp(
    `https?://${escapeRegExp(host)}/c/${escapeRegExp(classroomId)}/media/` +
      `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/` +
      // Up to the end of the URL: through an `&amp;`-escaped query, but never
      // past an HTML-escaped quote (`url(&quot;…&quot;)` in an inline style
      // keeps its closing quote).
      `(?:(?!&(?:quot|#34|#39);)[^"'\\s)<>])*`,
    'gi'
  );
  return html.replace(signed, (_match, id: string) => `media://${id.toLowerCase()}`);
}
