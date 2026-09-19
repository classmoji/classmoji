/**
 * `ClassmojiService.media` — the media store's whole public face.
 *
 * The operations, the policy they enforce (quota numbers, the kind allowlist)
 * and the error type a caller has to switch on, in one namespace. A route needs
 * all three to answer a request: the call, the code it failed with, and the
 * numbers to put in the body.
 *
 * The R2 client itself is NOT re-exported. `isMediaConfigured` is, because a
 * loader has to know whether to render the upload button; the S3 client is an
 * implementation detail and nothing outside this folder should hold one.
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

export { isMediaConfigured } from './r2Client.ts';

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

export {
  abortUpload,
  completeUpload,
  createUpload,
  deleteMedia,
  listMedia,
  onMediaReady,
  signParts,
  usage,
} from './media.service.ts';
export type { MediaOptions, MediaUsage } from './media.service.ts';
