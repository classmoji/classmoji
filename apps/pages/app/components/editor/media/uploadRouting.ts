import {
  MEDIA_QUOTA_FULL_MESSAGE,
  formatGigabytes,
  kindOfFilename,
  storageTargetFor,
  type UploadCapability,
} from '@classmoji/services/media/router';
import type { MediaUploadOptions, MultipartUploadError } from '@classmoji/ui-components/upload';
import { REPO_REST_MAX_BYTES, repoFileTooLargeMessage } from '@classmoji/utils/repo-limits';

/**
 * Where one file the page editor was handed goes, and what happens when the
 * server disagrees.
 *
 * The decision is the storage router's (`storageTargetFor`, decision §7.10):
 * a Pro video, or anything over the repository's cap on a classroom with media,
 * goes to media; everything else that fits goes to the repository; the rest is
 * refused with the router's own sentence. The capability comes from the page
 * loader and can be stale — the classroom may have gone Pro, or lapsed, since
 * the page was opened — and every server entry re-derives the target from the
 * file it receives. So the server's answer wins: a repository upload told
 * `USE_MEDIA`, or a media upload told `USE_REPO`, is sent to the other side
 * ONCE. A second disagreement is not chased back; it is refused.
 *
 * Pure, with the two transports passed in (`UploadPorts`), so the whole
 * decision table is testable without a network.
 */

/** Where a file was stored, and the URL to show it with right now. */
export interface PlacedUpload {
  /** What goes into the block: a repo path, or `media://{id}`. */
  ref: string;
  /** The signed URL for this session's display map, or null. */
  displayUrl: string | null;
  /** Where it went. */
  destination: 'repo' | 'media';
}

/** The server sent the file to the other store. */
export class UploadReroute extends Error {
  readonly to: 'repo' | 'media';
  constructor(to: 'repo' | 'media') {
    super(`Upload belongs in ${to}.`);
    this.name = 'UploadReroute';
    this.to = to;
  }
}

/** A refusal the uploader reads. The message is the sentence to show. */
export class UploadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRefused';
  }
}

/** The person cancelled. Not a failure — nothing is shown. */
export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelled';
  }
}

export interface UploadPorts {
  /** POST to the repository route. Throws `UploadReroute('media')` on `USE_MEDIA`. */
  toRepo(file: File): Promise<Omit<PlacedUpload, 'destination'>>;
  /** Multipart to media. Throws `UploadReroute('repo')` on `USE_REPO`. */
  toMedia(
    file: File,
    options: MediaUploadOptions | undefined
  ): Promise<Omit<PlacedUpload, 'destination'>>;
  /**
   * Ask the uploader for a video's three options (media plan §3.10) — the
   * shared dialog. Null when they cancelled. Asked only for a video that is
   * about to go to media, and only then: those choices mean nothing for a
   * repository file or for any other kind.
   */
  askVideoOptions(file: File): Promise<MediaUploadOptions | null>;
}

/** Whether a file is one the three video options apply to. */
export const takesVideoOptions = (file: { name: string }): boolean =>
  kindOfFilename(file.name) === 'VIDEO';

/** The first destination for a file, before any server has seen it. */
export function firstDestination(
  capability: UploadCapability | null | undefined,
  file: { name: string; size: number }
): { kind: 'repo' | 'media' } | { kind: 'refused'; message: string } {
  if (!capability) {
    // No capability (a lookup failed): the editor's behaviour before routing
    // existed. The repository route still redirects a media file, so a Pro
    // video is not lost — it takes one extra round trip.
    if (file.size > REPO_REST_MAX_BYTES) {
      return { kind: 'refused', message: repoFileTooLargeMessage(file.name) };
    }
    return { kind: 'repo' };
  }
  const target = storageTargetFor(capability, file);
  if (target.kind === 'refused') return { kind: 'refused', message: target.message };
  return target;
}

/** What a failed page action or upload route answers with: a code, and maybe the sentence. */
export type ActionFailure = { error?: unknown; message?: unknown };

/**
 * The sentence to show for a failed action: its `message` when it sent one,
 * else its `error` — never a bare code like `USE_MEDIA` or `CLASSROOM_LOCKED`
 * when the server said something a person can read.
 */
export function actionFailureMessage(data: ActionFailure | null | undefined): string | null {
  if (!data || !data.error) return null;
  if (typeof data.message === 'string' && data.message) return data.message;
  return typeof data.error === 'string' ? data.error : null;
}

/** The sentence when the two stores keep handing the file back to each other. */
const NOWHERE_MESSAGE = 'This file could not be stored. Reload the page and try again.';

/** Route, send, and follow at most one redirect. */
export async function placeUpload(
  file: File,
  capability: UploadCapability | null | undefined,
  ports: UploadPorts
): Promise<PlacedUpload> {
  const first = firstDestination(capability, file);
  if (first.kind === 'refused') throw new UploadRefused(first.message);

  const send = async (to: 'repo' | 'media'): Promise<PlacedUpload> => {
    if (to === 'repo') return { ...(await ports.toRepo(file)), destination: to };
    // A video's options are the uploader's to choose, right before the bytes
    // go — including a video the repository has just sent here.
    let options: MediaUploadOptions | undefined;
    if (takesVideoOptions(file)) {
      const chosen = await ports.askVideoOptions(file);
      if (!chosen) throw new UploadCancelled();
      options = chosen;
    }
    return { ...(await ports.toMedia(file, options)), destination: to };
  };

  try {
    return await send(first.kind);
  } catch (error) {
    if (!(error instanceof UploadReroute) || error.to === first.kind) throw error;
    try {
      return await send(error.to);
    } catch (second) {
      if (second instanceof UploadReroute) throw new UploadRefused(NOWHERE_MESSAGE);
      throw second;
    }
  }
}

/**
 * The line a media upload's progress toast reads: where the file is going and
 * how much room there was before it left. The room is the loader's figure
 * (`capability.media.remainingBytes`) — the server enforces the quota, this
 * only tells the uploader where they stand.
 */
export function mediaProgressLabel(
  file: { name: string },
  capability: UploadCapability | null | undefined
): string {
  const remaining = capability?.media?.remainingBytes;
  const free = typeof remaining === 'number' ? formatBytes(remaining) : '';
  return free
    ? `Saving ${file.name} to your class media — ${free} free`
    : `Saving ${file.name} to your class media`;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** `1.2 GB`, `35 MB`, `640 KB` — sizes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes === 0) return '0 KB';
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round((bytes / MB) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Media refusals that mean the capability the editor routed with was stale:
 * the classroom is no longer on Pro, can no longer serve content, or media is
 * not available right now. A file the repository can take goes there instead
 * — the upload the uploader asked for, in the other store. A full quota is
 * NOT one of these: a Pro class whose media is full is refused, with the
 * server's message, and never quietly put in the repository (Tim, 2026-09-27).
 */
const STALE_MEDIA_CODES = new Set(['PRO_REQUIRED', 'DELIVERY_REQUIRED', 'NOT_CONFIGURED']);

/**
 * Could the course repository take this file instead? The router's own rule
 * with media taken away — its size cap AND the classroom's type policy — so
 * this cannot promise a file the repository route would then refuse. With no
 * capability, the repository's size cap is all there is to go on.
 */
export function fitsRepoInstead(
  file: { name: string; size: number },
  capability: UploadCapability | null | undefined
): boolean {
  if (!capability) return file.size <= REPO_REST_MAX_BYTES;
  return storageTargetFor({ ...capability, media: null }, file).kind === 'repo';
}

/** Whether a media refusal should send the file to the repository instead. */
export function mediaRefusalGoesToRepo(
  code: string,
  file: { name: string; size: number },
  capability: UploadCapability | null | undefined
): boolean {
  return STALE_MEDIA_CODES.has(code) && fitsRepoInstead(file, capability);
}

/**
 * A media upload's failure, in a sentence.
 *
 * Codes come from the shared media routes; the wording follows the webapp's
 * upload dialog so the same refusal reads the same on every surface.
 */
export function mediaUploadMessage(
  error: Pick<MultipartUploadError, 'code' | 'usedBytes' | 'quotaBytes' | 'serverMessage'>,
  capability: UploadCapability | null | undefined
): string {
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return "Uploading here isn't available right now.";
    case 'PRO_REQUIRED':
      return 'Uploading media needs a Pro classroom.';
    case 'DELIVERY_REQUIRED':
      return "This class isn't set up to serve content yet, so media can't be uploaded.";
    case 'QUOTA_EXCEEDED':
      // The server's own sentence, verbatim: it says what to do about a full
      // store (who to contact to upgrade), which is not this client's to word.
      // The same sentence, from the same module, when it sent none.
      return error.serverMessage ?? MEDIA_QUOTA_FULL_MESSAGE;
    case 'FILE_TOO_LARGE': {
      // A decimal ceiling, read as the router reads it (`2 GB`).
      const limit = capability?.media?.perFileMaxBytes;
      return limit
        ? `That file is over the ${formatGigabytes(limit)} limit for a single upload.`
        : 'That file is over the limit for a single upload.';
    }
    case 'KIND_NOT_ALLOWED':
      return "That file can't be uploaded. It needs an extension of at most 8 letters or digits.";
    case 'SIZE_MISMATCH':
      return 'The upload did not arrive intact and was discarded. Please try again.';
    case 'VERIFY_FAILED':
      return "The upload couldn't be verified. Try again.";
    case 'UPLOAD_EXPIRED':
      return 'This upload took too long. Start it again.';
    case 'NOT_FOUND':
    case 'BAD_STATE':
      return 'This upload is no longer valid. Please start it again.';
    default:
      return 'The upload could not finish. Check your connection and try again.';
  }
}
