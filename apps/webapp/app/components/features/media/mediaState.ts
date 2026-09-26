import type { MediaProcessing, MediaRecord, MediaStatus } from '@classmoji/services';

/**
 * What the media page SHOWS about a row, derived rather than stored.
 *
 * The database keeps two independent facts — `status` (is the object there)
 * and `processing` (did the rendition job run) — and the page has one column.
 * Deriving the column here rather than in the table means the four states have
 * one definition, and that a row which is READY but still encoding cannot be
 * drawn as plain "ready" in one place and "optimising" in another.
 *
 * Kept away from the markup so it can be tested as the truth table it is.
 */

export type MediaState = 'uploading' | 'optimising' | 'ready' | 'failed';

export function mediaState(record: {
  status: MediaStatus;
  processing: MediaProcessing;
}): MediaState {
  if (record.status === 'UPLOADING') return 'uploading';

  // A READY row is already playable; processing only ever adds a better copy.
  // So FAILED is reported without pretending the object is unusable, and
  // PENDING says what is happening rather than leaving a silent delay.
  if (record.processing === 'PENDING') return 'optimising';
  if (record.processing === 'FAILED') return 'failed';
  return 'ready';
}

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
  ready: 'bg-mint-bg text-mint-ink !border-mint-bord',
  failed: 'bg-peach-bg text-peach-ink !border-peach-bord',
};

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
