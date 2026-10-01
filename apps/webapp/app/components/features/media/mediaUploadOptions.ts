/**
 * The decisions the upload dialog makes before a single byte moves.
 *
 * Pure on purpose, so the rules can be read and tested away from any markup.
 * The video choices themselves (the three boxes and how they are tied) are
 * shared by every upload surface and live in
 * `@classmoji/ui-components/media-options`; what is here is which files get
 * them and what the dialog checks before sending.
 *
 * The server checks every one of these again. What is here is only so an
 * instructor finds out that a 4 GB export is too big before they have spent
 * twenty minutes sending it.
 */

import { formatGigabytes, kindOfFilename } from '@classmoji/services/media/router';
import type { VideoOptions } from '@classmoji/ui-components/media-options';

/**
 * The kinds the store has a real type for, lowercased for this dialog. The
 * extension lists themselves are the storage router's (`kindOfFilename`, from
 * the browser-safe `@classmoji/services/media/router` subpath), so there is one
 * list of what counts as a video — the one the server classifies with. The
 * store takes ANY extension; everything it has no type for is `other` and is
 * served as a download, so the kind here only decides which files get the
 * video options.
 */
export type MediaKind = 'video' | 'audio' | 'document' | 'archive' | 'image' | 'other';

/**
 * The longest extension the store can address: its objects are keyed
 * `orig.{ext}` and that grammar allows 8 letters or digits. The server refuses
 * anything longer too; this is only so the uploader hears it before the bytes
 * move.
 */
export const MAX_MEDIA_EXTENSION_LENGTH = 8;

/**
 * A filename's extension by the server's rule (`sanitizedExtension`): the text
 * after the last dot of the basename, lowercase letters and digits only, and
 * none at all for a leading-dot name like `.gitignore`. `''` when there is none.
 */
export function extensionOf(filename: string): string {
  const name = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** The file's kind, `other` for an extension the store has no type for, null for none. */
export function kindForFilename(filename: string): MediaKind | null {
  if (!extensionOf(filename)) return null;
  return kindOfFilename(filename).toLowerCase() as MediaKind;
}

export const isVideoFilename = (filename: string) => kindForFilename(filename) === 'video';

/**
 * The `options` this dialog opens an upload with.
 *
 * `explicit` for EVERY file: this is the Media page's own Upload button, the
 * one surface where "store this in media" is the whole point — without it the
 * server keeps a small non-video file in the course repository (`USE_REPO`).
 * The video checkboxes ride along only for a video; for anything else the
 * server fixes them anyway.
 */
export function createUploadOptions(
  filename: string,
  options: VideoOptions
): Partial<VideoOptions> & { explicit: true } {
  return isVideoFilename(filename) ? { ...options, explicit: true } : { explicit: true };
}

/**
 * Sizes are counted in binary units and labelled in decimal ones, which is what
 * every operating system's file browser does and therefore what an instructor
 * comparing the two numbers expects.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB';
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

export interface QuotaSummary {
  usedBytes: number;
  quotaBytes: number;
  perFileBytes: number;
}

/**
 * The reason this file cannot be uploaded, or null.
 *
 * Any file with an extension can be — media is a Pro surface and takes
 * whatever the classroom needs to store. Order matters: a name the store cannot
 * address is told first because no amount of freeing space will help, and the
 * per-file ceiling before the quota because it is the fixed limit rather than
 * the one they can do something about.
 */
export function precheck(file: { name: string; size: number }, quota: QuotaSummary): string | null {
  const ext = extensionOf(file.name);
  if (!ext) return 'This file needs an extension, e.g. notes.txt';
  if (ext.length > MAX_MEDIA_EXTENSION_LENGTH) {
    return `File extensions can be at most ${MAX_MEDIA_EXTENSION_LENGTH} letters or digits (.${ext} is ${ext.length}).`;
  }
  if (file.size > quota.perFileBytes) {
    // Both in decimal gigabytes, the unit the ceiling is set in (`2 GB`), so
    // the two numbers compare the way they read.
    return `This file is ${formatGigabytes(file.size)}. The limit is ${formatGigabytes(quota.perFileBytes)} per file.`;
  }
  const free = Math.max(0, quota.quotaBytes - quota.usedBytes);
  if (file.size > free) {
    return `This file is ${formatBytes(file.size)} but only ${formatBytes(free)} of your ${formatBytes(quota.quotaBytes)} is free. Delete something first.`;
  }
  return null;
}
