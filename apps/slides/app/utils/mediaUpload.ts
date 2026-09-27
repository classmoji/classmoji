/**
 * mediaUpload.ts — the decisions the slides editors make before an upload
 * starts: where a file goes, which choices a video upload offers, and what an
 * uploader is told when it fails.
 *
 * Pure, and safe in the browser. The router comes through the
 * `@classmoji/services/media/router` subpath, whose whole graph is the router
 * and its file rule — never `@classmoji/services`, which would put Prisma and
 * the S3 client into the client bundle. Every server entry point asks the
 * router again from the file it actually received, so nothing decided here is
 * trusted there.
 */

import {
  MEDIA_QUOTA_FULL_MESSAGE,
  extensionsOfKind,
  kindOfFilename,
  storageTargetFor,
  type StorageTarget,
  type UploadCapability,
} from '@classmoji/services/media/router';
import {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  canDropOriginal,
  warnsWithoutOptimising,
  type VideoOptions,
} from '@classmoji/ui-components/media-options';
import { REPO_REST_MAX_BYTES, repoFileTooLargeMessage } from '@classmoji/utils/repo-limits';

export type { UploadCapability };

/** The file facts every decision here needs. A `File` satisfies it. */
export interface FileFacts {
  name: string;
  size: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a file goes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a file goes when the capability could not be worked out (the loader's
 * lookup failed): the course repository if it fits, as before routing existed.
 * The repository route still redirects a file that belongs in media
 * (`USE_MEDIA`), so a Pro video is not lost — it takes one extra round trip.
 */
function withoutCapability(file: FileFacts): StorageTarget {
  if (file.size <= REPO_REST_MAX_BYTES) return { kind: 'repo' };
  return { kind: 'refused', code: 'TOO_LARGE_FOR_REPO', message: repoFileTooLargeMessage() };
}

/**
 * Where a deck asset — a video or an image placed in the editor — goes.
 *
 * The router's own answer. A Pro classroom's videos go to media whatever their
 * size; anything over the repository's cap goes to media where the classroom
 * has it; everything else stays in the course repository.
 */
export function deckAssetTarget(
  capability: UploadCapability | null | undefined,
  file: FileFacts
): StorageTarget {
  if (!capability) return withoutCapability(file);
  return storageTargetFor(capability, { name: file.name, size: file.size });
}

/**
 * Where a FILE slide's document goes.
 *
 * Not the router alone: a slide document has its own extension list (PDF,
 * PowerPoint, Keynote) and its own upload path, and the router's repository
 * branch would judge a `.pptx` against the page-asset type policy — which on a
 * classroom without delivery is images and PDFs only. So the router is asked
 * only the question it owns here: may a file too large for the repository go
 * to media? A document that fits takes the slide's own repository path, whose
 * checks are unchanged.
 */
export function slideFileTarget(
  capability: UploadCapability | null | undefined,
  file: FileFacts
): StorageTarget {
  if (!capability) return withoutCapability(file);
  if (file.size <= capability.repoMaxBytes) return { kind: 'repo' };
  return storageTargetFor(capability, { name: file.name, size: file.size });
}

/** Is this a video by the store's own kind table? */
export function isVideoFile(file: Pick<FileFacts, 'name'>): boolean {
  return kindOfFilename(file.name) === 'VIDEO';
}

/** The video extensions the store knows — its own kind table, through the router. */
const VIDEO_EXTENSIONS = extensionsOfKind('VIDEO');

/**
 * What a video file picker offers: `video/*`, plus every extension by name —
 * several (.mkv, .avi, .mov on some systems) have no `video/` type a browser
 * will match on.
 */
export const VIDEO_FILE_ACCEPT = ['video/*', ...VIDEO_EXTENSIONS.map(ext => `.${ext}`)].join(',');

// The router's decimal formatter (the per-file cap is a decimal 2 GB) and the
// sentence every surface shows for a full quota.
export { formatGigabytes, MEDIA_QUOTA_FULL_MESSAGE } from '@classmoji/services/media/router';

// ─────────────────────────────────────────────────────────────────────────────
// Video upload options (plan §3.10 — the uploader's three choices, once)
// ─────────────────────────────────────────────────────────────────────────────

// The rules live once, with the component every upload dialog shows
// (`@classmoji/ui-components/media-options`); re-exported so this app's
// modules keep one import for everything an upload decides.
export { DEFAULT_VIDEO_OPTIONS, applyVideoOption, canDropOriginal, warnsWithoutOptimising };
export type { VideoOptions };

// ─────────────────────────────────────────────────────────────────────────────
// What a failed upload says
// ─────────────────────────────────────────────────────────────────────────────

/** The parts of a `MultipartUploadError` a message is built from. */
export interface UploadFailure {
  code?: string;
  /** The server's sentence, when it sent one. */
  message?: string;
  usedBytes?: number;
  quotaBytes?: number;
}

/** The server's own sentence, or null when all it said was a status. */
function serverSentence(failure: UploadFailure): string | null {
  const message = failure.message?.trim();
  if (!message || /^Upload failed \(\d+\)\.$/.test(message)) return null;
  return message;
}

/** Binary units, labelled as a file browser labels them. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} bytes`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The sentence an uploader reads when a media upload fails. Null for a cancel,
 * which is not a failure and says nothing.
 *
 * Codes come from the service; the wording is ours. Never the raw code.
 */
export function mediaUploadMessage(error: UploadFailure | null | undefined): string | null {
  switch (error?.code) {
    case 'ABORTED':
      return null;
    case 'NOT_CONFIGURED':
      return 'Media storage is not available right now.';
    case 'PRO_REQUIRED':
      return 'Media storage needs a Pro classroom.';
    case 'DELIVERY_REQUIRED':
      return "This class isn't set up to serve content yet, so media can't be uploaded.";
    case 'USE_REPO':
      return 'This file goes in the course repository. Reload the page and try again.';
    case 'QUOTA_EXCEEDED':
      // The server's sentence as it is: it says what to do (who to contact).
      // The shared one when it sent none.
      return serverSentence(error) ?? MEDIA_QUOTA_FULL_MESSAGE;
    case 'FILE_TOO_LARGE':
      return 'That file is over the limit for a single upload.';
    case 'KIND_NOT_ALLOWED':
      return "That file can't be uploaded. It needs an extension of at most 8 letters or digits.";
    case 'SIZE_MISMATCH':
      return 'The upload did not arrive intact and was discarded. Please try again.';
    case 'VERIFY_FAILED':
      return "The upload couldn't be verified. Please try again.";
    case 'UPLOAD_EXPIRED':
      return 'This upload took too long. Start it again.';
    case 'NOT_FOUND':
    case 'BAD_STATE':
      return 'This upload is no longer valid. Please start it again.';
    default:
      return 'The upload could not finish. Check your connection and try again.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// When the server disagrees with the browser's routing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a failed MEDIA upload means for the file, given what the browser knows.
 *
 * The capability the editor routed with can be stale (the class may have lapsed
 * from Pro, or its delivery setup changed, since the page was opened), and the
 * server is the one that decides. So:
 *
 *   - `USE_REPO` — the router keeps this file in the repository: go there.
 *   - `PRO_REQUIRED`, `DELIVERY_REQUIRED`, `NOT_CONFIGURED` — media cannot take
 *     it here. A file that fits the repository goes there; one that does not
 *     is refused with the router's own sentence for that case (what Pro
 *     stores, or that media is unavailable), never a Pro pitch for a file the
 *     repository could have taken.
 *   - `QUOTA_EXCEEDED` — refused with the server's sentence as it is, and never
 *     sent to the repository instead: a full quota is not a reason to put a
 *     class's videos in git.
 *   - anything else — refused with its sentence (null for a cancel).
 */
export function afterMediaFailure(
  failure: UploadFailure,
  file: FileFacts,
  capability: UploadCapability | null | undefined
): { kind: 'repo' } | { kind: 'refused'; message: string | null } {
  switch (failure.code) {
    case 'USE_REPO':
      return { kind: 'repo' };
    case 'PRO_REQUIRED':
    case 'DELIVERY_REQUIRED':
    case 'NOT_CONFIGURED': {
      const repoMaxBytes = capability?.repoMaxBytes ?? REPO_REST_MAX_BYTES;
      if (file.size <= repoMaxBytes) return { kind: 'repo' };
      // The router's answer for this file on a class without media: the Pro
      // note when the server says the class is not Pro, "media is unavailable"
      // otherwise.
      const target = storageTargetFor(
        {
          repoMaxBytes,
          repoFileTypes: capability?.repoFileTypes ?? 'any',
          isPro: failure.code === 'PRO_REQUIRED' ? false : (capability?.isPro ?? true),
          media: null,
        },
        { name: file.name, size: file.size }
      );
      return {
        kind: 'refused',
        message: target.kind === 'refused' ? target.message : mediaUploadMessage(failure),
      };
    }
    default:
      return { kind: 'refused', message: mediaUploadMessage(failure) };
  }
}

/** The sentence a failed media upload shows, for a caller with nowhere else to send it. */
export function mediaFailureMessage(
  failure: UploadFailure,
  file: FileFacts,
  capability: UploadCapability | null | undefined
): string | null {
  const outcome = afterMediaFailure(failure, file, capability);
  return outcome.kind === 'refused' ? outcome.message : mediaUploadMessage({ code: 'USE_REPO' });
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

/** The two ways a deck asset can travel. Each throws `UploadReroute` to hand the file over. */
export interface DeckUploadPorts {
  /** The deck's repository upload. `UploadReroute('media')` on `USE_MEDIA`. */
  toRepo(file: File): Promise<string>;
  /** Multipart to media. `UploadReroute('repo')` when `afterMediaFailure` says so. */
  toMedia(file: File): Promise<string>;
}

/** The sentence when the two stores keep handing the file back to each other. */
const NOWHERE_MESSAGE = 'This file could not be stored. Reload the page and try again.';

/**
 * Upload one deck asset where it belongs, and follow the server ONCE.
 *
 * The first destination is the router's (`deckAssetTarget`), or `first` when
 * the caller already knows (media refused a file that fits the repository).
 * A server that disagrees — the repository answering `USE_MEDIA`, media
 * answering `USE_REPO` or that it cannot take a file the repository can — gets
 * the file on the other side; a second disagreement is refused rather than
 * chased back. Resolves with the URL the editor places.
 */
export async function placeDeckAsset(
  file: File,
  capability: UploadCapability | null | undefined,
  ports: DeckUploadPorts,
  first?: 'repo' | 'media'
): Promise<string> {
  let to = first;
  if (!to) {
    const target = deckAssetTarget(capability, file);
    if (target.kind === 'refused') throw new Error(target.message);
    to = target.kind;
  }
  const send = (where: 'repo' | 'media') =>
    where === 'repo' ? ports.toRepo(file) : ports.toMedia(file);

  try {
    return await send(to);
  } catch (error: unknown) {
    if (!(error instanceof UploadReroute) || error.to === to) throw error;
    try {
      return await send(error.to);
    } catch (second: unknown) {
      if (second instanceof UploadReroute) throw new Error(NOWHERE_MESSAGE);
      throw second;
    }
  }
}

/** The processing choices a video placed straight from the editor gets: the dialog's defaults. */
export function editorMediaOptions(file: Pick<FileFacts, 'name'>): VideoOptions | undefined {
  return isVideoFile(file) ? { ...DEFAULT_VIDEO_OPTIONS } : undefined;
}

/**
 * The sentence for a refusal from the deck's own asset upload (`upload-image`).
 *
 * `USE_MEDIA` is a routing answer, not an error an author can act on by that
 * name — the server's `message` says what it means, and that is what is shown.
 * A code is never put in front of a person.
 */
export function deckUploadErrorMessage(response: { error?: unknown; message?: unknown }): string {
  if (typeof response.message === 'string' && response.message) return response.message;
  const error = typeof response.error === 'string' ? response.error : '';
  if (!error || /^[A-Z_]+$/.test(error)) return 'The upload could not finish. Please try again.';
  return error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media references in the editor
// ─────────────────────────────────────────────────────────────────────────────

/** `media://{uuid}` — the shape the resolver takes. */
const MEDIA_REF = /^media:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A signed media URL: `/c/{classroom}/media/{id}/{variant}`. */
const SIGNED_MEDIA_URL =
  /^https?:\/\/[^/]+\/c\/[0-9a-f-]{36}\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

/**
 * Is this `src` one of the classroom's media objects — a stored reference, or
 * the signed URL the editor holds for one? The properties panel shows these as
 * "in media" rather than as a long expiring URL nobody should copy.
 */
export function isMediaSource(src: string | null | undefined): boolean {
  if (!src) return false;
  return MEDIA_REF.test(src) || SIGNED_MEDIA_URL.test(src);
}
