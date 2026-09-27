/**
 * Media references and media URLs, recognised by shape.
 *
 * A file that lives in media storage is stored in a document as
 * `media://{uuid}` and shown through a signed URL of the form
 * `{origin}/c/{classroomId}/media/{mediaId}/{variant}?…`. Neither says what the
 * file IS by its ending — the reference has no extension at all, and the
 * signed URL ends in a variant (`orig.mov`, `web-{hex12}.mp4`) that is an
 * implementation detail — so everything that has to decide how to show one
 * decides by SCHEME, here, rather than by extension. A URL's path shape counts
 * only on the delivery origin's host, which callers pass in.
 *
 * Pure and import-free on purpose: the video block (client), the class-site
 * renderer (server) and the unit suite all read it, and none of them may pull
 * in the services root (Prisma) to learn the shape of a string. The shapes are
 * the ones `contentDelivery.service.ts` mints and parses (`MEDIA_REF`,
 * `MEDIA_URL`, `missingUrl`); keep them in step with it.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `media://{uuid}` — exactly, as `parseMediaRef` accepts it. */
const MEDIA_REF = new RegExp(`^media://(${UUID})$`);

/** A signed media URL: `/c/{classroomId}/media/{mediaId}/{variant}`. */
const MEDIA_DELIVERY_URL = new RegExp(`/c/${UUID}/media/${UUID}/[^/?#]+(?:[?#]|$)`, 'i');

/**
 * The resolver's placeholder for a media reference it could not sign (a
 * deleted object, one from another classroom, a layer switched off):
 * `/c/{classroomId}/missing/media%3A%2F%2F{mediaId}`.
 */
const MEDIA_PLACEHOLDER_URL = new RegExp(`/c/${UUID}/missing/media%3A%2F%2F${UUID}(?:[?#]|$)`, 'i');

/**
 * A signed delivery URL whose signature can expire and be re-minted: a repo
 * blob, a theme file, or a media object. A `/missing/` placeholder is not one
 * — it 404s after any number of revalidations.
 */
const RETRYABLE_DELIVERY_URL = new RegExp(`/c/${UUID}/(?:blob|theme|media)/`);

/** Formats a browser's `<video>` plays from a plain URL. */
const DIRECT_VIDEO_EXTENSION = /\.(mp4|webm|ogg|mov|m4v|mkv)(?:[?#]|$)/i;

/** The media id a `media://` reference names, or null. */
export function parseMediaRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const match = MEDIA_REF.exec(ref);
  return match ? match[1] : null;
}

export function isMediaRef(ref: unknown): ref is string {
  return parseMediaRef(ref) !== null;
}

/**
 * Is this URL on the delivery origin — the one host that mints media URLs?
 *
 * The shapes below are only a claim about the PATH, and anybody can host that
 * path: a pasted `https://elsewhere.test/c/{uuid}/media/{uuid}/x` matches them
 * exactly. So a shape match counts only on our own host, compared the way
 * `contentDelivery.service.ts`'s `isOwnDeliveryHost` compares it. The origin
 * is a parameter rather than read here, because this module is shared with the
 * client and must stay import- and env-free; the server passes
 * `CONTENT_DELIVERY_ORIGIN`. No origin (a deployment that mints nothing) means
 * no URL is ours.
 */
function onDeliveryOrigin(url: string, deliveryOrigin: string | null | undefined): boolean {
  if (!deliveryOrigin) return false;
  try {
    return new URL(url).host.toLowerCase() === new URL(deliveryOrigin).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The placeholder a media reference resolves to when it cannot be signed —
 * on `deliveryOrigin` only (see `onDeliveryOrigin`).
 */
export function isMediaPlaceholderUrl(
  url: unknown,
  deliveryOrigin: string | null | undefined
): url is string {
  return (
    typeof url === 'string' &&
    MEDIA_PLACEHOLDER_URL.test(url) &&
    onDeliveryOrigin(url, deliveryOrigin)
  );
}

/**
 * A signed media URL, or the placeholder a media reference resolves to when it
 * cannot be signed — on `deliveryOrigin` only (see `onDeliveryOrigin`).
 */
export function isMediaUrl(url: unknown, deliveryOrigin: string | null | undefined): url is string {
  return (
    typeof url === 'string' &&
    (MEDIA_DELIVERY_URL.test(url) || MEDIA_PLACEHOLDER_URL.test(url)) &&
    onDeliveryOrigin(url, deliveryOrigin)
  );
}

/** Whether a failed load of this URL is worth one loader revalidation. */
export function isRetryableDeliveryUrl(url: unknown): boolean {
  return typeof url === 'string' && RETRYABLE_DELIVERY_URL.test(url);
}

/**
 * Should a video block play this in a native `<video>` rather than embed it?
 *
 * By scheme first — a media reference, or a media URL on `deliveryOrigin`, is
 * always a file this app serves — and only then by extension, for a direct
 * link somebody pasted. Everything else (YouTube, Vimeo, an arbitrary page,
 * a media-shaped URL on somebody else's host) is judged like any other link.
 */
export function playsAsNativeVideo(
  url: unknown,
  deliveryOrigin: string | null | undefined
): boolean {
  if (typeof url !== 'string' || !url) return false;
  if (isMediaRef(url) || isMediaUrl(url, deliveryOrigin)) return true;
  return DIRECT_VIDEO_EXTENSION.test(url);
}
