import {
  contentTypeForMediaExt,
  isClassroomId,
  isMediaId,
  isMediaVariant,
  mediaKey,
} from '@classmoji/content-signing';

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

/**
 * `m/{classroomId}/` — everything one classroom has in the media bucket.
 *
 * The id is checked, because this string is handed to a LIST-and-delete: an
 * empty id would be `m//`, and a truncated one would match its neighbours'
 * prefixes too. Only a whole, lowercase classroom uuid gets a prefix at all.
 */
export function mediaPrefix(classroomId: string): string {
  if (!isClassroomId(classroomId)) {
    throw new TypeError(`media: not a classroom id (got ${classroomId})`);
  }
  return `m/${classroomId}/`;
}

/**
 * `stage/{classroomId}/{mediaId}` — where an AGENT upload's bytes wait to be placed.
 *
 * MCP `file_upload_start` hands an agent one presigned PUT for this key, and
 * `file_import_url` streams a fetched URL into it. Nothing is served from here:
 * the Worker only ever builds `m/…` keys (`mediaKey`), so a staged object is
 * unreachable until placement copies it into `m/…` or commits it to the
 * content repo, and then it is deleted. What placement never gets to — a stage
 * nobody finished — the bucket's own lifecycle rule for this prefix expires
 * after a day, so there is no sweep job.
 *
 * A prefix of its own, OUTSIDE `m/`, so neither the Worker nor anything that
 * lists a classroom's `m/{classroomId}/` ever mistakes an unverified upload for
 * a stored object. No extension: the key names a row, and the row knows the
 * filename. Both ids are checked for the same reason `mediaPrefix` checks its
 * one — this string is also handed to a delete.
 */
export function stageKey(classroomId: string, mediaId: string): string {
  if (!isClassroomId(classroomId)) {
    throw new TypeError(`media: not a classroom id (got ${classroomId})`);
  }
  if (!isMediaId(mediaId)) {
    throw new TypeError(`media: not a media id (got ${mediaId})`);
  }
  return `stage/${classroomId}/${mediaId}`;
}

/** `stage/{classroomId}/` — every staged object one classroom has, for the purge. */
export function stagePrefix(classroomId: string): string {
  if (!isClassroomId(classroomId)) {
    throw new TypeError(`media: not a classroom id (got ${classroomId})`);
  }
  return `stage/${classroomId}/`;
}
