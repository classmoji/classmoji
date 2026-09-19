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
  /** The filename's extension is not on the allowlist. */
  | 'KIND_NOT_ALLOWED'
  /** The classroom's owner has no active PRO subscription. */
  | 'PRO_REQUIRED'
  /** One file past the per-file ceiling, regardless of how much quota is free. */
  | 'FILE_TOO_LARGE'
  /** This file would put the classroom over its quota. Carries the numbers. */
  | 'QUOTA_EXCEEDED'
  /** No such row, or a row belonging to another classroom — the same answer. */
  | 'NOT_FOUND'
  /** The row is not in the status this operation needs (completing a READY row). */
  | 'BAD_STATE'
  /** The object R2 assembled is not the size that was declared and reserved. */
  | 'SIZE_MISMATCH';

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
