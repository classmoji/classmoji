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
  kindOfFilename,
  storageTargetFor,
  type StorageTarget,
  type UploadCapability,
} from '@classmoji/services/media/router';
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

/**
 * The video extensions the store knows (`MEDIA_KINDS` in the services' kind
 * table, which the router subpath does not export). Filtered through the
 * router's own `kindOfFilename`, so one the store stops calling a video drops
 * out on its own; a test pins that this list covers every VIDEO extension.
 */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'].filter(
  ext => kindOfFilename(`video.${ext}`) === 'VIDEO'
);

/**
 * What a video file picker offers: `video/*`, plus every extension by name —
 * several (.mkv, .avi, .mov on some systems) have no `video/` type a browser
 * will match on.
 */
export const VIDEO_FILE_ACCEPT = ['video/*', ...VIDEO_EXTENSIONS.map(ext => `.${ext}`)].join(',');

/** `2 GB` — the per-file ceiling as a person reads it. */
export function formatGigabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video upload options (plan §3.10 — the uploader's three choices, once)
// ─────────────────────────────────────────────────────────────────────────────

export interface VideoOptions {
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
}

/** Optimise on, keep the original on, no student download. */
export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  optimise: true,
  keepOriginal: true,
  allowDownload: false,
};

/**
 * Apply one checkbox, keeping the pair that cannot disagree in step: with
 * optimising off the original is the only copy, so "Keep the original" is
 * forced on (and shown disabled) rather than hidden.
 */
export function applyVideoOption(
  options: VideoOptions,
  field: keyof VideoOptions,
  next: boolean
): VideoOptions {
  const updated = { ...options, [field]: next };
  if (!updated.optimise) updated.keepOriginal = true;
  return updated;
}

/** Whether "Keep the original" can be unticked in the state it is in now. */
export const canDropOriginal = (options: VideoOptions): boolean => options.optimise;

/** Containers whose usual codecs a browser may refuse when served untouched. */
const FRAGILE_VIDEO_EXTENSIONS = ['mov'];

/** True when an un-optimised upload would likely not play for part of the class. */
export function warnsWithoutOptimising(filename: string, options: VideoOptions): boolean {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return !options.optimise && FRAGILE_VIDEO_EXTENSIONS.includes(ext);
}

// ─────────────────────────────────────────────────────────────────────────────
// What a failed upload says
// ─────────────────────────────────────────────────────────────────────────────

/** The parts of a `MultipartUploadError` a message is built from. */
export interface UploadFailure {
  code?: string;
  message?: string;
  usedBytes?: number;
  quotaBytes?: number;
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
      return 'Storing files this large needs a Pro classroom.';
    case 'DELIVERY_REQUIRED':
      return "This class isn't set up to serve content yet, so media can't be uploaded.";
    case 'QUOTA_EXCEEDED':
      return error.usedBytes !== undefined && error.quotaBytes !== undefined
        ? `Not enough storage — ${formatSize(error.usedBytes)} of ${formatSize(error.quotaBytes)} is already in use. Delete something from Media and try again.`
        : 'Not enough media storage left. Delete something from Media and try again.';
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
