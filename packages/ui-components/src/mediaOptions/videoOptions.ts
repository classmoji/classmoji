/**
 * The three upload-time choices for a video, and the rules that tie them.
 *
 * Locked by the media plan (§3.10): Optimise for streaming (on), Keep the
 * original (on, and only untickable while optimising), Allow download (off).
 * They are set in the upload dialog or nowhere — there is no per-video control
 * afterwards for anyone — which is why the rules live here, once, for every
 * surface that uploads a video (the webapp's media page, the page editor, the
 * slides editor).
 *
 * Pure and dependency-free: it runs in the browser, and it must not reach into
 * `@classmoji/services`. Deciding WHETHER a file is a video is the caller's
 * job (`kindOfFilename` from `@classmoji/services/media/router`); these rules
 * only apply once it has.
 */

export interface VideoOptions {
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
}

/** §3.10: optimise on, keep the original on, no student download. */
export const DEFAULT_VIDEO_OPTIONS: Readonly<VideoOptions> = Object.freeze({
  optimise: true,
  keepOriginal: true,
  allowDownload: false,
});

/** Containers whose usual codecs a browser may refuse when served untouched. */
const FRAGILE_VIDEO_EXTENSIONS = ['mov'];

/**
 * A filename's extension by the server's rule: the text after the last dot of
 * the basename, lowercase letters and digits only, none for a leading-dot name.
 */
function extensionOf(filename: string): string {
  const name = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

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
export const canDropOriginal = (options: VideoOptions): boolean => options.optimise;

/**
 * True when the file would very likely play for the uploader and fail for half
 * their class. A `.mov` off a Mac is usually HEVC, which Firefox does not
 * decode and Windows only does with a codec pack — exactly what optimising
 * fixes, which is why this only matters when they have turned optimising off.
 */
export const warnsWithoutOptimising = (filename: string, options: VideoOptions): boolean =>
  !options.optimise && FRAGILE_VIDEO_EXTENSIONS.includes(extensionOf(filename));
