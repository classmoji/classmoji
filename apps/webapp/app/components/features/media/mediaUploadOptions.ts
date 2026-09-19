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
 * Duplicated rather than imported because this list drives a file picker in the
 * browser, and the services package is server-side (Prisma, the S3 client).
 * When a kind is added there, add it here; the server refuses anything this
 * list lets through by mistake, so the two can only disagree about politeness.
 */
export const MEDIA_EXTENSIONS = {
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'm4a', 'wav'],
  document: ['pdf', 'ppt', 'pptx', 'key'],
  archive: ['zip'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
} as const;

export type MediaKind = keyof typeof MEDIA_EXTENSIONS;

/** What the `<input type="file">` offers, e.g. `.mp4,.webm,…`. */
export const MEDIA_ACCEPT = Object.values(MEDIA_EXTENSIONS)
  .flat()
  .map(ext => `.${ext}`)
  .join(',');

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

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function kindForFilename(filename: string): MediaKind | null {
  const ext = extensionOf(filename);
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(ext)) return kind as MediaKind;
  }
  return null;
}

export const isVideoFilename = (filename: string) => kindForFilename(filename) === 'video';

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
 * Order matters: an unsupported type is told first because no amount of freeing
 * space will help, and the per-file ceiling before the quota because it is the
 * fixed limit rather than the one they can do something about.
 */
export function precheck(file: { name: string; size: number }, quota: QuotaSummary): string | null {
  if (!kindForFilename(file.name)) {
    const ext = extensionOf(file.name);
    return `${ext ? `.${ext} files` : 'Files with no extension'} can't be uploaded. Accepted: ${MEDIA_ACCEPT.replaceAll('.', '').replaceAll(',', ', ')}.`;
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
