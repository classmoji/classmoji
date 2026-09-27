/**
 * `@classmoji/ui-components/media-options` — the video upload choices every
 * upload dialog shows (media plan §3.10): the component and its rules.
 *
 * Browser-safe and free of `@classmoji/services`. Whether a file IS a video is
 * the caller's call, with `kindOfFilename` from
 * `@classmoji/services/media/router`.
 */

import './styles.css';

export { MediaVideoOptions, default } from './MediaVideoOptions.tsx';
export type { MediaVideoOptionsProps } from './MediaVideoOptions.tsx';
export {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  canDropOriginal,
  warnsWithoutOptimising,
} from './videoOptions.ts';
export type { VideoOptions } from './videoOptions.ts';
