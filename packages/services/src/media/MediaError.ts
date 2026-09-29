/**
 * Why a media operation refused.
 *
 * A code rather than a message, because every caller has to MAP it: the HTTP
 * routes turn each one into a specific status (`QUOTA_EXCEEDED` is a 409 with
 * numbers in the body, `FILE_TOO_LARGE` a 413, `KIND_NOT_ALLOWED` a 422), and a
 * UI has to say something different for each. A service that threw strings
 * would make every one of those a substring match.
 *
 * Each of these is a NORMAL outcome of a well-formed request — a free
 * classroom, a file that is too big, a race between two uploads for the last
 * gigabyte. None of them is a bug, and none of them should reach an error
 * reporter as an unhandled throw.
 */
export type MediaErrorCode =
  /** No R2 credentials on this deployment. The feature is off, not broken. */
  | 'NOT_CONFIGURED'
  /**
   * The filename has no extension the store can address: none at all, or one
   * longer than the `orig.{ext}` variant allows. The message says which.
   */
  | 'KIND_NOT_ALLOWED'
  /** The classroom's owner has no active PRO subscription. */
  | 'PRO_REQUIRED'
  /**
   * The classroom cannot serve content through the delivery layer, so an
   * uploaded object would have no URL anyone could load. Distinct from
   * `NOT_CONFIGURED`: the deployment is fine, this classroom is not ready.
   */
  | 'DELIVERY_REQUIRED'
  /** One file past the per-file ceiling, regardless of how much quota is free. */
  | 'FILE_TOO_LARGE'
  /** This file would put the classroom over its quota. Carries the numbers. */
  | 'QUOTA_EXCEEDED'
  /** No such row, or a row belonging to another classroom — the same answer. */
  | 'NOT_FOUND'
  /** The row is not in the status this operation needs (completing a READY row). */
  | 'BAD_STATE'
  /** The object R2 assembled is not the size that was declared and reserved. */
  | 'SIZE_MISMATCH'
  /**
   * The assembled object could not be read back, so its size was never checked.
   * Treated exactly like a mismatch — the object is discarded rather than kept
   * unverified — and distinct only so the client can say "try again" instead of
   * "your file was the wrong size".
   */
  | 'VERIFY_FAILED'
  /**
   * The upload was opened longer ago than its reservation lasts
   * (`RESERVATION_WINDOW_MS`). Its bytes stopped counting against the quota
   * when the window closed, so letting it finish would store a file the quota
   * never covered. It has been cancelled; the uploader starts again.
   */
  | 'UPLOAD_EXPIRED'
  /**
   * The storage router keeps this file in the course repository — it is not a
   * video and it fits the repository's cap (decision §7.10) — and the upload
   * did not say it was a deliberate "store this in media" (`explicit`, which
   * only Settings → Media's own Upload button sends).
   */
  | 'USE_REPO'
  /**
   * An agent upload (`file_upload_start`, `file_import_url`) the storage router
   * cannot place anywhere this classroom can put it — too large for the
   * repository with no media, a type the repository policy refuses, or over
   * media's own per-file ceiling. The message is the router's sentence.
   */
  | 'STORAGE_REFUSED'
  /**
   * The classroom already has as many agent uploads waiting to be placed as it
   * may (bytes or count). Admission control for the `stage/` prefix, whose
   * lifecycle deletion is asynchronous and so cannot be the limit itself.
   */
  | 'STAGE_LIMIT'
  /**
   * `file_upload_finish` was called before the file was uploaded to the staged
   * URL (there is no object there yet). Not terminal: upload, then finish.
   */
  | 'NOT_UPLOADED';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /** Present on QUOTA_EXCEEDED, so a caller can show "9.4 / 10 GB used". */
  readonly usedBytes?: number;
  readonly quotaBytes?: number;

  constructor(
    code: MediaErrorCode,
    message?: string,
    details?: { usedBytes?: number; quotaBytes?: number }
  ) {
    super(message ?? code);
    this.name = 'MediaError';
    this.code = code;
    if (details?.usedBytes !== undefined) this.usedBytes = details.usedBytes;
    if (details?.quotaBytes !== undefined) this.quotaBytes = details.quotaBytes;
  }
}

/**
 * Is this a refusal from the media service, or something that actually broke?
 *
 * `instanceof` alone is not reliable across a package boundary if the module
 * ever ends up duplicated, and a route that guesses wrong turns a quota refusal
 * into a 500. The name check is the cheap belt to the `instanceof` braces.
 */
export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError || (error as Error | null)?.name === 'MediaError';
}
