/**
 * `ClassmojiService.media` — the media store's whole public face.
 *
 * The operations, the policy they enforce (quota numbers, the kind allowlist)
 * and the error type a caller has to switch on, in one namespace. A route needs
 * all three to answer a request: the call, the code it failed with, and the
 * numbers to put in the body.
 *
 * ## Read statically, write lazily
 *
 * The halves of this module have very different costs. The READ half — the
 * lookups, the kind allowlist, the quota numbers, `servedVariant` — is what the
 * delivery resolver needs to render a page, and it is plain data code. The
 * WRITE half opens multipart uploads, which means `@aws-sdk/client-s3` and its
 * transitive packages, in the module graph of every app that touches this
 * barrel — including the two that only ever RENDER and never upload.
 *
 * So the read half is exported directly and `media.service.ts` is reached
 * through `import()` on first use. The call shape is unchanged: every write was
 * already async, so `ClassmojiService.media.createUpload(...)` still returns a
 * promise and no caller had to be touched. The module is cached after the first
 * load, so the cost is one resolution per process, on the first upload.
 *
 * The R2 client itself is NOT exported. `isMediaConfigured` is, because a
 * loader has to know whether to render the upload button — and it lives in
 * `mediaConfig.ts` rather than beside the client for exactly the reason above.
 */

export { MediaError, isMediaError } from './MediaError.ts';
export type { MediaErrorCode } from './MediaError.ts';

export {
  MEDIA_KINDS,
  allowedExtensions,
  classifyFilename,
  contentTypeForExt,
  extensionOf,
  kindForExt,
} from './mediaKinds.ts';
export type { MediaKind } from './mediaKinds.ts';

export {
  FREE_QUOTA_BYTES,
  MAX_PARTS_PER_SIGN,
  PART_SIZE_BYTES,
  PER_FILE_MAX_BYTES,
  PRO_QUOTA_BYTES,
  RESERVATION_WINDOW_MS,
  partCountFor,
  quotaBytesFor,
} from './mediaQuota.ts';

export { isMediaConfigured } from './mediaConfig.ts';

export {
  findMediaRow,
  lookupReadyMedia,
  mediaRef,
  servedVariant,
  toMediaRecord,
} from './mediaLookup.ts';
export type {
  MediaClassroom,
  MediaProcessing,
  MediaRecord,
  MediaRow,
  MediaStatus,
} from './mediaLookup.ts';

// Type-only, so it is erased: naming the module in a type position does not
// put it in anybody's bundle.
export type { MediaOptions, MediaUsage } from './media.service.ts';
type MediaWrites = typeof import('./media.service.ts');

/**
 * The write half, loaded once and remembered.
 *
 * The promise is cached rather than the module, so two uploads racing on a cold
 * process share one load instead of starting two.
 *
 * A REJECTION is not remembered. A dynamic import can fail for reasons that
 * have nothing to do with the module — a chunk that did not arrive, a disk that
 * blinked — and a cached rejected promise would answer every upload for the
 * rest of the process with a failure that one retry would have fixed. Clearing
 * the cache on the way out costs a second resolution in the only case where the
 * first one was worth nothing.
 */
let writes: Promise<MediaWrites> | null = null;
function mediaWrites(): Promise<MediaWrites> {
  writes ??= import('./media.service.ts').catch(error => {
    writes = null;
    throw error;
  });
  return writes;
}

export async function createUpload(
  args: Parameters<MediaWrites['createUpload']>[0]
): ReturnType<MediaWrites['createUpload']> {
  return (await mediaWrites()).createUpload(args);
}

export async function signParts(
  args: Parameters<MediaWrites['signParts']>[0]
): ReturnType<MediaWrites['signParts']> {
  return (await mediaWrites()).signParts(args);
}

export async function completeUpload(
  args: Parameters<MediaWrites['completeUpload']>[0]
): ReturnType<MediaWrites['completeUpload']> {
  return (await mediaWrites()).completeUpload(args);
}

export async function abortUpload(
  args: Parameters<MediaWrites['abortUpload']>[0]
): ReturnType<MediaWrites['abortUpload']> {
  return (await mediaWrites()).abortUpload(args);
}

export async function deleteMedia(
  args: Parameters<MediaWrites['deleteMedia']>[0]
): ReturnType<MediaWrites['deleteMedia']> {
  return (await mediaWrites()).deleteMedia(args);
}

/**
 * `usage` and `listMedia` are reads, but they live with the writes.
 *
 * They are the admin media page's two calls and they run on the same request
 * that may be about to upload, so paying for the module there costs nothing
 * that was not about to be paid anyway. Splitting them out would buy a render
 * path that does not call them a saving it already has.
 */
export async function usage(
  args: Parameters<MediaWrites['usage']>[0]
): ReturnType<MediaWrites['usage']> {
  return (await mediaWrites()).usage(args);
}

export async function listMedia(
  args: Parameters<MediaWrites['listMedia']>[0]
): ReturnType<MediaWrites['listMedia']> {
  return (await mediaWrites()).listMedia(args);
}

export async function onMediaReady(
  args: Parameters<MediaWrites['onMediaReady']>[0]
): ReturnType<MediaWrites['onMediaReady']> {
  return (await mediaWrites()).onMediaReady(args);
}
