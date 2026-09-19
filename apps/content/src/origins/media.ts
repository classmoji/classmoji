/**
 * The media origin: large uploads, read straight out of the `MEDIA` bucket.
 *
 * Deliberately NOT an `OriginAdapter`. That seam describes a REMOTE origin
 * reached with a repo and an installation token, and everything it carries —
 * `org`, `repo`, `token`, `fetchTree` — is meaningless here: the bytes are
 * already in R2, in this account, one HTTP hop from the client. What is left is
 * a `head` and a `get`, which is what this class is.
 *
 * It is also the end of the line. There is no backing store behind the bucket,
 * so an object that is not here is a 404 rather than a cache miss, and nothing
 * on this path ever writes: the app uploads over the S3 API, and the Worker
 * only reads.
 */
import { contentTypeForPath } from '../content-type.ts';
import type { Env } from '../env.ts';
import { contentTypeForMediaExt, mediaKey } from '../verify.ts';

/** Which object: one variant of one media row in one classroom. */
export interface MediaObjectRef {
  classroomId: string;
  mediaId: string;
  variant: string;
}

export interface MediaHead {
  /** R2's own metadata — the size a range is resolved against, and the etag. */
  object: R2Object;
  contentType: string;
}

export interface MediaBody extends MediaHead {
  object: R2ObjectBody;
}

/**
 * What to serve this object as.
 *
 * The stored `httpMetadata.contentType` is trusted here, and that is the
 * opposite of the blob path's rule — for the opposite reason. A blob key is
 * content-addressed and shared across classrooms, so its stored type is
 * whichever extension reached those bytes first. A media key names ONE row in
 * ONE classroom, and its type was assigned by `createUpload` from an allowlist
 * rather than taken from the uploader.
 *
 * The fallback is the variant's own extension, never a sniff of the bytes:
 * `web.mp4` is video, `poster.webp` is an image, and an `orig.{ext}` we have no
 * mapping for is an opaque download. Together with `nosniff` and the sandboxing
 * CSP (see cache.ts) that is what keeps an uploaded document from ever being
 * run as something else.
 *
 * An `orig.{ext}` is resolved against the MEDIA store's own table first — the
 * same one the app assigned the stored type from — so a fallback answers what
 * the upload would have answered. `content-type.ts` is the general web table
 * and knows nothing of `mov`, `mp3` or `zip`, which are precisely the
 * extensions a fallback is reached for. Only when neither knows the extension
 * is the object an opaque download.
 */
const ORIG_PREFIX = 'orig.';

function contentTypeOf(object: R2Object, variant: string): string {
  const stored = object.httpMetadata?.contentType;
  if (typeof stored === 'string' && stored.trim().length > 0) return stored;
  if (variant.startsWith(ORIG_PREFIX)) {
    const mediaType = contentTypeForMediaExt(variant.slice(ORIG_PREFIX.length));
    if (mediaType !== null) return mediaType;
  }
  return contentTypeForPath(variant);
}

export class MediaOrigin {
  /**
   * We never redirect. A presigned R2 URL would leave `finalizeHeaders` behind
   * — no CORS, no nosniff, no CSP — and hand the browser a URL this Worker no
   * longer controls. Proxying an R2 read costs nothing worth that.
   */
  readonly canPresign = false;

  /** Metadata only: no bytes are read, which is what answers a HEAD. */
  async head(env: Env, ref: MediaObjectRef): Promise<MediaHead | null> {
    const object = await env.MEDIA.head(mediaKey(ref.classroomId, ref.mediaId, ref.variant));
    if (!object) return null;
    return { object, contentType: contentTypeOf(object, ref.variant) };
  }

  /**
   * The object's bytes, or exactly the bytes of `range` when one is given —
   * R2's own ranged read, so a seek into the middle of a two-hour lecture costs
   * what a seek into its first second costs.
   */
  async get(env: Env, ref: MediaObjectRef, range?: R2Range): Promise<MediaBody | null> {
    const key = mediaKey(ref.classroomId, ref.mediaId, ref.variant);
    const object = await env.MEDIA.get(key, range ? { range } : undefined);
    if (!object) return null;
    return { object, contentType: contentTypeOf(object, ref.variant) };
  }
}
