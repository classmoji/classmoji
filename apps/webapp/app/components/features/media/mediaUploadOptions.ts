/**
 * The decisions the upload dialog makes before a single byte moves.
 *
 * Pure on purpose. The dialog is the only place a video's processing options
 * can ever be set — there is no per-video control afterwards for anyone — so
 * the rules about which boxes appear and which of them may be unticked are
 * worth reading and testing on their own, away from any markup.
 *
 * The server checks every one of these again. What is here is only so an
 * instructor finds out that a 4 GB export is too big before they have spent
 * twenty minutes sending it.
 */

/**
 * SOURCE OF TRUTH: `packages/services/src/media/mediaKinds.ts`.
 *
 * The extensions the store has a real type for, grouped by kind. The store
 * takes ANY extension — everything not listed here is kind `other` and is
 * served as a download — so this list no longer decides what may be picked;
 * it only decides which files get the video options. Duplicated rather than
 * imported because it runs in the browser, and the services package is
 * server-side (Prisma, the S3 client).
 */
export const MEDIA_EXTENSIONS = {
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'm4a', 'wav'],
  document: ['pdf', 'ppt', 'pptx', 'key'],
  archive: ['zip'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
} as const;

export type MediaKind = keyof typeof MEDIA_EXTENSIONS | 'other';

/**
 * The longest extension the store can address: its objects are keyed
 * `orig.{ext}` and that grammar allows 8 letters or digits. The server refuses
 * anything longer too; this is only so the uploader hears it before the bytes
 * move.
 */
export const MAX_MEDIA_EXTENSION_LENGTH = 8;

/** Containers whose usual codecs a browser may refuse when served untouched. */
const FRAGILE_VIDEO_EXTENSIONS = ['mov'];

export interface VideoOptions {
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
}

/** §3.10: optimise on, keep the original on, no student download. */
export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  optimise: true,
  keepOriginal: true,
  allowDownload: false,
};

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
  const ext = extensionOf(filename);
  if (!ext) return null;
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(ext)) return kind as MediaKind;
  }
  return 'other';
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
 * True when the file would very likely play for the uploader and fail for half
 * their class. A `.mov` off a Mac is usually HEVC, which Firefox does not
 * decode and Windows only does with a codec pack — exactly what optimising
 * fixes, which is why this only matters when they have turned optimising off.
 */
export const warnsWithoutOptimising = (filename: string, options: VideoOptions) =>
  !options.optimise && FRAGILE_VIDEO_EXTENSIONS.includes(extensionOf(filename));

/**
 * Apply one checkbox toggle, keeping the pair that cannot disagree in step.
 *
 * "Keep the original" only means anything when there is a second copy to keep
 * it alongside. With optimising off the original IS the only copy, so the box
 * is forced on and disabled rather than hidden: an instructor who unticks
 * Optimise should see that their file is still safe, not watch a control
 * vanish and wonder what it did.
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

/** Whether "Keep the original" can be unticked in the state it is now in. */
export const canDropOriginal = (options: VideoOptions) => options.optimise;

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
    return `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(quota.perFileBytes)} per file.`;
  }
  const free = Math.max(0, quota.quotaBytes - quota.usedBytes);
  if (file.size > free) {
    return `This file is ${formatBytes(file.size)} but only ${formatBytes(free)} of your ${formatBytes(quota.quotaBytes)} is free. Delete something first.`;
  }
  return null;
}
