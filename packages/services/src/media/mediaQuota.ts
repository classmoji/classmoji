/**
 * How much a classroom may store, in one place.
 *
 * Constants rather than env vars on purpose. These are PRODUCT limits — what a
 * Pro subscription includes — not deployment tuning, and an env var would mean
 * staging and production could silently disagree about what a customer bought.
 * Changing them is a code change with a commit message, which is the right
 * amount of friction.
 */

const GIB = 1024 * 1024 * 1024;

/**
 * FREE is zero, not a small allowance. Media is a Pro feature; a nonzero free
 * tier would mean a lapsed subscription leaves files that are over the limit
 * the moment they lapse, and there is deliberately no machinery to delete them.
 */
export const FREE_QUOTA_BYTES = 0;

/** 10 GiB — roughly a term of lecture video after the rendition pass. */
export const PRO_QUOTA_BYTES = 10 * GIB;

/**
 * The per-file ceiling, checked before the quota and separately from it.
 *
 * Two different refusals: a 3 GB file is rejected on an empty 10 GiB quota
 * too, because a single object that large is a sign of an unprocessed screen
 * recording rather than a lecture, and the rendition job would be an hour of
 * encode. Well under R2's own 5 TiB object limit — this is a product choice.
 *
 * 2,000,000,000 bytes — a DECIMAL 2 GB, not 2 GiB — so every size a media file
 * can have fits a signed 32-bit integer: `Slide.source_size` (a media-backed
 * file slide records its document's size) is an `Int`, and 2 GiB is one byte
 * past its maximum. It reads as "2 GB" (`formatGigabytes`).
 */
export const PER_FILE_MAX_BYTES = 2_000_000_000;

/**
 * How long an unfinished upload holds its bytes against the quota.
 *
 * This is what stops two uploads started a second apart from both fitting in
 * the same remaining gigabyte. It is a WINDOW rather than a lock because it has
 * to expire on its own: a browser that closes mid-upload never calls abort, and
 * the alternative to ageing the reservation out is a sweep job for a problem
 * that solves itself. R2 aborts the abandoned multipart at 7 days, so the
 * bytes it holds are not paid for either.
 *
 * 24 hours is generous by design — long enough that a genuinely slow 2 GiB
 * upload on a bad connection is never undercut by its own reservation
 * expiring, short enough that an abandoned one is not felt for a week.
 */
export const RESERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Multipart part size. 32 MiB, inside R2's 5 MiB–5 GiB range.
 *
 * It sets how many URLs a 2 GiB upload needs (64) and how much work a retried
 * part costs. Smaller would mean hundreds of round trips and a lot of signing;
 * larger would make a flaky connection re-send more on every failure.
 */
export const PART_SIZE_BYTES = 32 * 1024 * 1024;

/** The most part numbers one signing call will mint URLs for. */
export const MAX_PARTS_PER_SIGN = 50;

/**
 * What a Pro class is told when its media storage is full (decided 2026-09-27):
 * no repository fallback, a way to get more. Every surface that refuses on the
 * quota — the upload routes, agent uploads, MCP — carries this sentence, with
 * the numbers (`usedBytes`, `quotaBytes`) alongside it. Plain data, so a
 * browser can show the same words (`@classmoji/services/media/router`).
 */
export const MEDIA_QUOTA_FULL_MESSAGE =
  "This class's media storage is full. Contact hello@classmoji.io to upgrade.";

export function quotaBytesFor(isPro: boolean): number {
  return isPro ? PRO_QUOTA_BYTES : FREE_QUOTA_BYTES;
}

/** How many parts a file of this size is uploaded in. At least one, always. */
export function partCountFor(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / PART_SIZE_BYTES));
}
