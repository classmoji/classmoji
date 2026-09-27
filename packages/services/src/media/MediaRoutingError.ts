/**
 * A repository upload refused because the storage router sends the file to media.
 *
 * Not a `MediaError`: nothing is wrong with the file and media did not refuse
 * it. It reached the wrong store — a Pro video, or a file over the
 * repository's cap on a classroom that has media — and the caller's answer is
 * to send it again through the media upload instead. So it has its own type,
 * one code, and one response every surface answers with.
 *
 * Deliberately no `status` property. The page cover handler already reads
 * `error.status === 409` as "the metadata write lost to a concurrent edit",
 * and a second error answering to the same probe would be reported as that.
 */

export type MediaRoutingCode = 'USE_MEDIA';

export class MediaRoutingError extends Error {
  readonly code: MediaRoutingCode;

  constructor(code: MediaRoutingCode, message?: string) {
    super(message ?? 'This file is stored in media storage, not the course repository.');
    this.name = 'MediaRoutingError';
    this.code = code;
  }
}

/** By name as well as class, for the same reason as `isMediaError`. */
export function isMediaRoutingError(error: unknown): error is MediaRoutingError {
  return (
    error instanceof MediaRoutingError ||
    ((error as Error | null)?.name === 'MediaRoutingError' &&
      (error as { code?: unknown }).code === 'USE_MEDIA')
  );
}

/**
 * The response a repository upload route answers with, or null when `error` is
 * not a routing refusal: 409 `{ error: 'USE_MEDIA', message }`.
 *
 * One helper so the pages upload, the page cover and anything else that
 * commits a user's file answer byte-for-byte alike — the editor switches on
 * `body.error`, and a surface that spelled it differently would be one where a
 * Pro video fails instead of being re-sent to media.
 */
export function mediaRoutingResponse(error: unknown): Response | null {
  if (!isMediaRoutingError(error)) return null;
  return Response.json({ error: error.code, message: error.message }, { status: 409 });
}
