import { mapBlockAssetRefs } from '@classmoji/utils';

import { isMediaRef } from '~/utils/mediaRefs.ts';

/**
 * The last word on `media://` before a class-site page becomes HTML.
 *
 * A media reference is not a URL. The bytes live in R2 and are reachable only
 * through a URL the resolver signs, so a `media://…` string that reaches the
 * markup is at best a dead `src` and at worst a link a visitor clicks and gets
 * nothing from — and it names a storage row in public HTML for no reason.
 *
 * The resolver already answers every media reference it is asked about (a
 * signed URL, or the `/missing/` placeholder when it cannot sign). What it
 * cannot answer is the call it never gets: the site passes the ORIGINAL blocks
 * through when the classroom has no resolve context, when the resolve throws,
 * or when the deployment has no delivery origin at all. Those three are the
 * degradations the site deliberately takes rather than 503ing, and this is
 * what keeps them from leaking the reference.
 *
 * Kept out of `pageRender.server.ts` (which imports the database) so the unit
 * suite can hold it without a Prisma client.
 */

/** A clone of the blocks with every unresolved media reference emptied. */
export function withoutUnresolvedMediaRefs<T>(blocks: T): T {
  // Emptied, not removed: an empty `url` is the state every block already
  // renders as nothing on the site (the static video and image renders, and
  // the unset-file redaction).
  return mapBlockAssetRefs(blocks, ref => (isMediaRef(ref) ? '' : ref));
}

/** The cover, or none when it is still a media reference nobody signed. */
export function coverWithoutUnresolvedMediaRef<C extends { url: string } | null>(
  cover: C
): C | null {
  if (!cover) return cover;
  return isMediaRef(cover.url) ? null : cover;
}
