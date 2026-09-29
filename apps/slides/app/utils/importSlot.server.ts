/**
 * importSlot.server.ts — how many slides.com imports this process runs at once:
 * one.
 *
 * The limits in `importVideoMedia.ts` bound ONE import — the ZIP it buffered
 * (up to 150 MB), what it inflates, what it holds for its commit — and at its
 * peak one comes to a bit over 1 GiB. The slides machine has 2 GB and serves
 * everybody's decks from the same process, so a second import running beside
 * the first is enough to take it down.
 *
 * So the import endpoint takes this slot before it reads the body and gives it
 * back when the import it started settles (or at once, when it answers without
 * starting one). The shape is `@classmoji/utils/upload-concurrency`'s: refuse
 * rather than queue, because a queued import would hold its request and the
 * body already sent for as long as the one ahead of it takes — the same memory
 * one step later. The import screen shows the refusal's sentence as it shows
 * any other failure to start.
 *
 * Per process, like the upload slots: each slides machine counts its own.
 */

/** Slots. One: two imports at once do not fit on the slides machine. */
export const MAX_CONCURRENT_IMPORTS = 1;

/** How long a refused importer is told to wait, in seconds. */
export const IMPORT_RETRY_AFTER_SECONDS = 60;

/** The sentence a refused importer reads. */
export const IMPORT_BUSY_MESSAGE = 'Another import is running right now. Please try again shortly.';

let inFlight = 0;

/**
 * Take the slot, or don't. Every caller that got true MUST release it exactly
 * once — when the import it started settles, or when it returns without
 * starting one.
 */
export function acquireImportSlot(): boolean {
  if (inFlight >= MAX_CONCURRENT_IMPORTS) return false;
  inFlight += 1;
  return true;
}

/** Give the slot back. Never drops below zero, whatever the caller does. */
export function releaseImportSlot(): void {
  if (inFlight > 0) inFlight -= 1;
}

/** For tests and for a log line — never for a decision, which is the acquire. */
export function importsInFlight(): number {
  return inFlight;
}
