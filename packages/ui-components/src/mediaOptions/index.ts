/**
 * `@classmoji/ui-components/media-options` — the video upload choices every
 * upload dialog shows (media plan §3.10): the component and its rules.
 *
 * Browser-safe and free of `@classmoji/services`. Whether a file IS a video is
 * the caller's call, with `kindOfFilename` from
 * `@classmoji/services/media/router`.
 *
 * The component's stylesheet is `@classmoji/ui-components/styles/media-options.css`
 * and the app imports it (from its CSS entry, or next to the dialog that
 * renders this). It is deliberately NOT imported from here: modules that only
 * need the rules, or that sit in a server-rendered graph a test harness loads
 * without a CSS pipeline, must be able to import this entry.
 */

export { MediaVideoOptions, default } from './MediaVideoOptions.tsx';
export type { MediaVideoOptionsProps } from './MediaVideoOptions.tsx';
export {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  canDropOriginal,
  warnsWithoutOptimising,
} from './videoOptions.ts';
export type { VideoOptions } from './videoOptions.ts';
