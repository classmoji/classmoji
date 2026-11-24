import { isMediaRef } from '~/utils/mediaRefs.ts';

/**
 * The last word on a `media://` cover before a class-site page is served.
 *
 * A media reference is not a URL. The bytes live in R2 and are reachable only
 * through a URL the resolver signs, so a `media://…` string that reaches the
 * markup is at best a dead background image, and it names a storage row in
 * public HTML for no reason. Inside the document the reader payload removes
 * a media block whose reference did not resolve and empties every other
 * unresolved reference (`buildReaderPayload`, on every asset prop: `url`,
 * a profile's `imageUrl`); the cover is drawn by the site's own chrome, so it
 * is checked here.
 *
 * Kept out of `pageRender.server.ts` (which imports the database) so the unit
 * suite can hold it without a Prisma client.
 */

/** The cover, or none when it is still a media reference nobody signed. */
export function coverWithoutUnresolvedMediaRef<C extends { url: string } | null>(
  cover: C
): C | null {
  if (!cover) return cover;
  return isMediaRef(cover.url) ? null : cover;
}
