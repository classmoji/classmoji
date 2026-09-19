import { contentTypeForMediaExt, isMediaVariant, mediaKey } from '@classmoji/content-signing';

/**
 * The R2 key shape, re-exported from the signing package.
 *
 * It lives there because the WORKER has to build the identical key from the URL
 * path it just verified, and the app has to build it to write the object — two
 * codebases, one string, and a drift between them is a 404 nobody can explain.
 * Nothing here takes a secret or produces a signature, so none of it is behind
 * the `no-restricted-imports` gate, which names the signing exports alone.
 * Everything else in `src/media/` still reaches these helpers through here, so
 * there is one place to look for what the two sides have agreed on.
 *
 * Its own file so the media modules that only READ — the delivery resolver's
 * lookup, the record shape — can have the key grammar without pulling the S3
 * client and its transitive AWS dependencies into their import graph.
 */
export { isMediaVariant, mediaKey };

/**
 * The stored/served content type for an extension, from the same table the
 * Worker falls back to. Re-exported here rather than imported directly by
 * `mediaKinds.ts` for the reason above: this module is the media folder's one
 * door onto the signing package.
 */
export { contentTypeForMediaExt };

/**
 * The `orig` variant for an extension, or null when it is not one the variant
 * grammar accepts.
 *
 * Built and then CHECKED rather than pattern-matched here, so the grammar stays
 * in the one place the Worker reads it from: whatever `isMediaVariant` accepts
 * is what this can produce, by construction.
 */
export function origVariant(ext: string): string | null {
  if (typeof ext !== 'string') return null;
  const variant = `orig.${ext.toLowerCase()}`;
  return isMediaVariant(variant) ? variant : null;
}
