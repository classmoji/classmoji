/**
 * repoLimits.ts — how large one file committed to a course repository may be.
 *
 * One number, read by every surface that puts a file into a content repo: page
 * assets and covers, deck images, file slides, page imports, the slides.com
 * import, the MCP asset tool, and the client-side checks in front of each. It
 * lives here rather than in `@classmoji/services` because the browser needs it
 * too (a dialog that refuses a 60 MB file before sending it), and this module
 * has no imports at all, so a client bundle that reaches for it pulls in
 * nothing else.
 *
 * Every sentence a person reads about the limit is built from the constant, so
 * changing the one number below changes the product everywhere at once.
 */

/**
 * 35 MiB. Above this a file is refused before a byte is committed.
 *
 * The number is GitHub's, not a policy call. Every write path we have — the
 * Contents API `PUT`, and `POST /repos/{owner}/{repo}/git/blobs` behind both
 * `ContentService.upload` and `uploadBatch` — sends the file base64-encoded
 * inside a JSON body. GitHub refuses a request body of roughly 50 MB or more
 * with "Sorry, your input was too large to process", and base64 makes a file a
 * third larger on the way out, so what bounds an upload is the file AFTER
 * encoding.
 *
 * Measured on staging against a real content repo, 2026-09-19: 30 MB and 35 MB
 * (46.7 MB encoded) both committed, in 50–70 s; 40 MB (53.3 MB encoded), 50 MB
 * and 74 MB were all refused. GitHub's own per-file ceiling (100 MiB on every
 * commit path) is well above this, so it never decides anything here.
 */
export const REPO_REST_MAX_BYTES = 35 * 1024 * 1024;

const MIB = 1024 * 1024;

/**
 * A byte count as a person reads it: `35 MB`, `120 MB`, `4.2 MB`.
 *
 * Binary units (1 MB = 1 MiB) so the cap reads as the round number it is. One
 * decimal below 100 MB, where rounding would hide the difference that matters
 * ("35 MB" for a 35.4 MB file refused by a 35 MB cap reads as a
 * contradiction), whole numbers above; a whole value never grows a ".0".
 */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / MIB;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${Math.round(mb * 10) / 10} MB`;
}

/** The cap as a person reads it — `35 MB`. */
export const REPO_REST_MAX_LABEL = formatMegabytes(REPO_REST_MAX_BYTES);

/**
 * What a person is told when a file is over the cap.
 *
 * States the limit and nothing about why: the transport is not something an
 * instructor can act on, and a sentence about base64 would only read as an
 * excuse. `name` is included when there is more than one file in play (an
 * import), so the refusal says which one.
 */
export function repoFileTooLargeMessage(name?: string): string {
  const subject = name ? name : 'This file';
  return `${subject} is larger than the ${REPO_REST_MAX_LABEL} your course repository accepts.`;
}

/**
 * The warning for a file an import skipped rather than refused — the import
 * went ahead without it. `Skipped lecture.mp4 (120 MB) — larger than the 35 MB
 * your course repository accepts`.
 */
export function repoFileSkippedWarning(name: string, bytes: number): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — larger than the ` +
    `${REPO_REST_MAX_LABEL} your course repository accepts`
  );
}

/** True when a file of `bytes` is over the cap. The cap itself is allowed. */
export function exceedsRepoFileLimit(bytes: number): boolean {
  return bytes > REPO_REST_MAX_BYTES;
}

/**
 * 150 MiB — the most one import upload may send: a slides.com export ZIP (the
 * slides app's import route and its client-side check) and a page import body
 * (the webapp). Not a repository limit — nothing this size is committed whole;
 * each file inside is checked against `REPO_REST_MAX_BYTES` (or routed to
 * media) — but a bound on what one request may make the server buffer. One
 * number, so the route and the dialog in front of it can never disagree.
 */
export const SLIDES_IMPORT_MAX_BYTES = 150 * MIB;

/** The import cap as a person reads it — `150 MB`. */
export const SLIDES_IMPORT_MAX_LABEL = formatMegabytes(SLIDES_IMPORT_MAX_BYTES);
