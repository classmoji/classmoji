/**
 * mediaRouterShared.ts — TEMPORARY local copies of two names the services
 * slice adds to `@classmoji/services/media/router` (branch
 * feat/media-p3-review-services), so this branch typechecks before that one
 * merges. Same values, same behaviour.
 *
 * AFTER THE MERGE, replace everything below this comment with ONE line:
 *
 *   export { formatGigabytes, MEDIA_QUOTA_FULL_MESSAGE } from '@classmoji/services/media/router';
 *
 * Browser-safe: no imports.
 */

const GB = 1_000_000_000;

/** `2 GB` — decimal gigabytes, as the per-file ceiling (2,000,000,000 bytes) is set. */
export function formatGigabytes(bytes: number): string {
  return `${Math.round((bytes / GB) * 10) / 10} GB`;
}

/** What every surface says when a class's media quota is full. */
export const MEDIA_QUOTA_FULL_MESSAGE =
  "This class's media storage is full. Contact hello@classmoji.io to upgrade.";
