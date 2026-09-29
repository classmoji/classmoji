import type { MediaProcessing, MediaRecord, MediaStatus } from '@classmoji/services';

import { formatBytes } from './mediaUploadOptions';

/**
 * What the media page SHOWS about a row, derived rather than stored.
 *
 * The database keeps two independent facts — `status` (is the object there)
 * and `processing` (did the video job run) — and the page has one label.
 * Deriving it here rather than in the table means the states have one
 * definition, and that a row which is READY but still being optimised cannot be
 * drawn one way in one place and another way somewhere else.
 *
 * A READY row with no processing to report (`NONE`: not a video, not marked
 * optimise, or uploaded before optimising existed) shows NOTHING — null — and
 * that is most rows.
 *
 * Kept away from the markup so it can be tested as the truth table it is.
 */

export type MediaState = 'uploading' | 'optimising' | 'optimised' | 'failed';

export function mediaState(record: {
  status: MediaStatus;
  processing: MediaProcessing;
}): MediaState | null {
  // STAGING is an agent's upload waiting to be placed: in flight, like a
  // browser upload, and holding its reservation the same way.
  if (record.status === 'UPLOADING' || record.status === 'STAGING') return 'uploading';

  // A READY row is already playable; processing only ever adds a better copy.
  // So FAILED is reported without pretending the object is unusable.
  if (record.processing === 'PENDING') return 'optimising';
  if (record.processing === 'DONE') return 'optimised';
  if (record.processing === 'FAILED') return 'failed';
  return null;
}

/** The words each state is shown as. */
export const MEDIA_STATE_LABEL: Record<MediaState, string> = {
  uploading: 'Uploading',
  optimising: 'Optimising',
  optimised: 'Optimised',
  failed: 'Couldn’t optimise — the original is shown',
};

/**
 * The chip classes for each state, spelled out rather than built from a tone
 * name: Tailwind reads the source for class literals, so `bg-${tone}-bg` would
 * generate nothing. The border carries `!` for the reason `SlideKindChip`
 * documents — `.chip` is unlayered CSS and its transparent border would
 * otherwise win. One class pair covers both themes, because the tone variables
 * are redefined under `html.dark`.
 */
export const MEDIA_STATE_CHIP: Record<MediaState, string> = {
  uploading: 'bg-sky-bg text-sky-ink !border-sky-bord',
  optimising: 'bg-amber-bg text-amber-ink !border-amber-bord',
  optimised: 'bg-mint-bg text-mint-ink !border-mint-bord',
  failed: 'bg-peach-bg text-peach-ink !border-peach-bord',
};

/**
 * The secondary line under a video whose original was dropped once its
 * streaming copy existed (`original_deleted_at`). Downloads hand over the copy.
 */
export const ORIGINAL_NOT_KEPT_LABEL = 'Original not kept';

/** How often the page reloads its rows while one of them is still optimising. */
export const PENDING_REVALIDATE_MS = 15_000;

/**
 * Whether any row is still optimising — the only case in which the page reloads
 * itself. Everything else changes only when the owner does something here.
 */
export function hasPendingProcessing(
  records: readonly { status: MediaStatus; processing: MediaProcessing }[]
): boolean {
  return records.some(record => mediaState(record) === 'optimising');
}

/** Only a finished object can be handed over or referenced. */
export const isActionable = (record: { status: MediaStatus }) => record.status === 'READY';

export interface MeterReading {
  /** 0–100, clamped. */
  percent: number;
  /** True at 90 % or more, which is what turns the meter red. */
  isFull: boolean;
}

/**
 * The usage meter.
 *
 * A zero quota is the free tier, and it reads as 0 % rather than the division
 * by zero or the permanently-full bar either obvious shortcut would give:
 * nothing is used, nothing can be, and a red bar would be telling a free
 * classroom off for storage it never had.
 */
export function meterReading(usedBytes: number, quotaBytes: number): MeterReading {
  if (!(quotaBytes > 0)) return { percent: 0, isFull: false };
  const percent = Math.min(100, Math.max(0, (usedBytes / quotaBytes) * 100));
  return { percent, isFull: percent >= 90 };
}

export interface UsageLine {
  /** What the page says about the classroom's storage. */
  text: string;
  /** The bar and percentage, only when there is a quota to measure against. */
  meter: MeterReading | null;
}

/**
 * The line above the media table.
 *
 * With a quota (Pro) it is `X of Y used` and the meter. Without one (a free
 * classroom, or one whose Pro has lapsed) there is nothing to be a share of,
 * so it is only what is stored — `X stored`, no bar — and nothing at all when
 * nothing is stored.
 */
export function usageLine(usage: { usedBytes: number; quotaBytes: number }): UsageLine | null {
  if (usage.quotaBytes > 0) {
    return {
      text: `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used`,
      meter: meterReading(usage.usedBytes, usage.quotaBytes),
    };
  }
  if (usage.usedBytes > 0) return { text: `${formatBytes(usage.usedBytes)} stored`, meter: null };
  return null;
}

/**
 * Rows newest first, with anything still in flight pinned to the top.
 *
 * `createdAt` is widened to accept a string because a loader hands the client
 * an ISO timestamp, while the service hands the server a `Date`; both sort the
 * same way through `new Date()`.
 */
export function orderForDisplay<
  T extends { status: MediaRecord['status']; createdAt: string | Date },
>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const inFlight = Number(b.status === 'UPLOADING') - Number(a.status === 'UPLOADING');
    if (inFlight !== 0) return inFlight;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
