/**
 * uploadConcurrency.server.ts — how many slide-file uploads one process holds
 * at a time.
 *
 * The size cap in `./uploadLimit` bounds ONE upload. It says nothing about ten
 * of them arriving together, and a slide file is allowed to be 35 MB: the
 * multipart parser assembles the body, produces the file part from it and the
 * action then hands the bytes to the service, so a single upload is worth
 * several times the file on the heap while it is in flight. A handful at once
 * is enough to take a small Fly machine down, and the slides app serves
 * everybody's decks from the same process.
 *
 * So the heavy actions take a slot first and give it back in a `finally`. Over
 * the limit the answer is 503 with `Retry-After` — a plain "come back in a
 * moment", not a failure the uploader can do anything about by changing the
 * file.
 *
 * `.server.ts` because the count has to be ONE number per process. A copy of
 * this module in a browser bundle would be a per-tab counter, which is no
 * counter at all.
 */

/** Slots. Two, so one large upload never blocks the next person entirely. */
export const MAX_CONCURRENT_UPLOADS = 2;

/** How long a refused uploader is told to wait, in seconds. */
export const UPLOAD_RETRY_AFTER_SECONDS = 30;

/** The sentence a refused uploader reads. */
export const UPLOAD_BUSY_MESSAGE =
  'The server is handling as many uploads as it can hold right now. Wait a moment and try again.';

let inFlight = 0;

/**
 * Take a slot, or don't.
 *
 * Returns false instead of queueing: a queued upload holds its request — and
 * its socket, and whatever the client has already sent — open for as long as
 * the ones ahead of it take, which is the same resource problem one step later.
 * Every caller MUST release in a `finally` when this returned true.
 */
export function acquireUploadSlot(): boolean {
  if (inFlight >= MAX_CONCURRENT_UPLOADS) return false;
  inFlight += 1;
  return true;
}

/** Give a slot back. Never drops below zero, whatever the caller does. */
export function releaseUploadSlot(): void {
  if (inFlight > 0) inFlight -= 1;
}

/** For tests and for a log line — never for a decision, which is the acquire. */
export function uploadsInFlight(): number {
  return inFlight;
}
