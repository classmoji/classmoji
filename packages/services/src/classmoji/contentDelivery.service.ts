import getPrisma from '@classmoji/database';

/**
 * Content delivery controls that are not about the asset map itself.
 *
 * Right now that is one thing: the cache bust.
 */

/**
 * Bump a classroom's content key version — the edge-cache bust.
 *
 * Every signed content URL carries the version, so incrementing it changes ALL
 * of a classroom's URLs at once and the CDN misses on every asset until it
 * refills from origin. That is the entire mechanism, and it is worth being
 * precise about what it is NOT:
 *
 *   - It is not a revocation. A URL minted under version 3 still verifies after
 *     the bump to 4; anyone holding one keeps their access. This changes which
 *     URL the app hands out, nothing more.
 *   - It is not a repair for wrong content. If the map says a path is at the
 *     wrong sha, a fresh URL points at the same wrong sha — that is a sync
 *     problem, and `syncContentAssets` is the fix.
 *
 * What it IS for: a stale or poisoned edge cache, where the origin is right and
 * the copy in front of it is not.
 *
 * The write is a relative increment (`{ increment: 1 }`) rather than a
 * read-then-write, so two owners clicking at the same moment produce two bumps
 * instead of one lost update. Both land, which is harmless — the version is
 * only ever compared for equality with itself.
 */
export async function bumpContentKeyVersion(
  classroomId: string
): Promise<{ content_key_version: number }> {
  const updated = await getPrisma().classroom.update({
    where: { id: classroomId },
    data: { content_key_version: { increment: 1 } },
    select: { content_key_version: true },
  });

  return { content_key_version: updated.content_key_version };
}
