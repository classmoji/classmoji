/**
 * File validation for binary uploads into a course content repository.
 *
 * ## Size
 *
 * One ceiling, `REPO_REST_MAX_BYTES` (35 MB) from `@classmoji/utils/repo-limits`
 * — GitHub's REST write limit, measured, and recorded there. It is the same
 * number the slide-file path and the imports use, so a file one surface accepts
 * is never refused by another for its size.
 *
 * ## Type — two policies, chosen by the CLASSROOM
 *
 * - `'any'`: any extension. Only for a classroom the delivery layer serves
 *   (`canDeliverContent`), because what makes an arbitrary file safe to host is
 *   the delivery Worker: it types a blob from its signed extension alone, serves
 *   anything it does not know as `application/octet-stream`, and sends
 *   `nosniff` plus a sandboxing CSP on every response — an uploaded `.html` is
 *   an inert document in an opaque origin, never script on a cookie domain.
 * - `'allowlist'` (the default): images and PDFs only, exactly as before. A
 *   classroom the layer does not serve has its files read straight from GitHub,
 *   where none of the above applies.
 *
 * The default is the narrow one on purpose: a caller that forgets to ask about
 * the classroom gets today's behaviour, never the wider one.
 *
 * ## Names
 *
 * Whatever the policy, a name must be a name: no path separators (it is a
 * basename, and becomes one segment of a git path), and not empty or only dots.
 * Under `'any'` it must also keep an extension after sanitizing, because the
 * extension is the only thing that types the stored file — and that extension
 * must fit `MAX_EXT_LENGTH` (from `@classmoji/content-signing`), because a
 * longer one would commit but could never be addressed by a signed URL
 * (`EXT_PATTERN`/`orig.{ext}` in `content-signing/canonical.ts` sign only 1–8
 * characters). The media store (`media/mediaKinds.ts`) checks the same limit
 * with the same message, so a name one store refuses is refused everywhere.
 * `sanitizeFilename` then reduces it to lowercase ASCII — extension included,
 * which matters once any extension is allowed, because the extension lands in
 * the path verbatim.
 */

import { MAX_EXT_LENGTH } from '@classmoji/content-signing';
import { REPO_REST_MAX_BYTES, repoFileTooLargeMessage } from '@classmoji/utils';

/**
 * The most one uploaded file may be — `REPO_REST_MAX_BYTES`, under the name the
 * existing importers (the `@classmoji/content` shim, the MCP tools) know it by.
 */
export const MAX_FILE_SIZE = REPO_REST_MAX_BYTES;

/** The extensions a classroom the delivery layer does not serve may upload. */
export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'];

/** Which file types an upload may be — see the module comment. */
export type FileTypePolicy = 'allowlist' | 'any';

/** Longest extension kept by `sanitizeFilename`. Past every real one (`ipynb`, `xlsx`). */
const MAX_EXTENSION_LENGTH = 16;

/**
 * Why a file was refused on its name or type — the three refusals that are the
 * uploader's to fix, and never a fault of ours.
 *
 * - `'type'`: the extension is not one this classroom's policy takes.
 * - `'extension'`: under `'any'`, no extension survives sanitizing, or it is
 *   longer than a signed URL can carry.
 * - `'name'`: not a name at all — a path, or empty, or only dots.
 *
 * Size is not here: a file too large for a repository is
 * `RepoFileTooLargeError` (`../repoLimits.ts`), which GitHub can raise as well
 * as we can.
 */
export type FileRefusalReason = 'type' | 'extension' | 'name';

/**
 * `validateFile`'s refusal, thrown — so a route or a tool maps it by its type
 * rather than by reading the sentence.
 *
 * `status` is the HTTP answer it deserves: 415 for a type or an extension (the
 * name is fine; what it is, is not accepted here), 400 for a name that is not
 * one. `code` is what `uploadRefusalStatus` and the MCP registry match on, the
 * way they match `RepoFileTooLargeError`'s, so an error that crossed a module
 * boundary is still recognised.
 */
export class FileRefusedError extends Error {
  readonly code = 'FILE_REFUSED' as const;
  readonly reason: FileRefusalReason;
  readonly status: 400 | 415;

  // No constructor parameter properties: see `RepoFileTooLargeError`.
  constructor(message: string, reason: FileRefusalReason) {
    super(message);
    this.name = 'FileRefusedError';
    this.reason = reason;
    this.status = reason === 'name' ? 400 : 415;
  }
}

/**
 * The HTTP status for an upload refusal, or null for anything that is not one.
 *
 * The one place that decides it for every upload boundary: 413 for a file too
 * large for the repository (`RepoFileTooLargeError`, ours or GitHub's), 415 or
 * 400 for a `FileRefusedError`. Anything else is a genuine failure and stays
 * the caller's 500. Matched on `code`, like `isCommitTooLargeRefusal`, rather
 * than `instanceof`, so it holds for an error re-created across a boundary.
 */
export function uploadRefusalStatus(error: unknown): 400 | 413 | 415 | null {
  if (!error || typeof error !== 'object') return null;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (code === 'REPO_FILE_TOO_LARGE') return 413;
  if (code === 'FILE_REFUSED') return status === 400 ? 400 : 415;
  return null;
}

/**
 * Validate a file for upload.
 *
 * `fileTypes` defaults to `'allowlist'`; pass `'any'` only for a classroom
 * `canDeliverContent` says yes to.
 */
export function validateFile({
  filename,
  size,
  fileTypes = 'allowlist',
}: {
  filename: string;
  size: number;
  fileTypes?: FileTypePolicy;
}): {
  valid: boolean;
  error?: string;
  /** Why it was refused; `'too_large'` is the one `FileRefusedError` does not carry. */
  reason?: FileRefusalReason | 'too_large';
} {
  if (size > MAX_FILE_SIZE) {
    return { valid: false, error: repoFileTooLargeMessage(), reason: 'too_large' };
  }

  const name = typeof filename === 'string' ? filename.trim() : '';
  if (/[/\\]/.test(name)) {
    return { valid: false, error: 'File names cannot contain "/" or "\\".', reason: 'name' };
  }
  if (!name || /^\.+$/.test(name)) {
    return { valid: false, error: 'That file needs a name.', reason: 'name' };
  }

  if (fileTypes === 'any') {
    // The extension is what types the file once it is stored — the delivery
    // Worker reads nothing else — so a name that keeps none after sanitizing
    // (`Makefile`, `.gitignore`, `x.データ`, a bare `.png`) is refused rather
    // than stored as an untyped blob.
    const ext = sanitizedExtension(name);
    if (!ext) {
      return {
        valid: false,
        error: 'This file needs an extension, e.g. notes.txt',
        reason: 'extension',
      };
    }
    // A name that keeps an extension longer than the signer will ever sign
    // would commit fine but could never be served via a signed URL — refuse
    // it here instead, with the message the media store also uses.
    if (ext.length > MAX_EXT_LENGTH) {
      return {
        valid: false,
        error: extensionTooLongMessage(ext, extensionLength(name)),
        reason: 'extension',
      };
    }
    return { valid: true };
  }

  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      reason: 'type',
    };
  }

  return { valid: true };
}

/**
 * Why an extension is too long to ever be signed — shared verbatim by
 * `validateFile`'s `'any'` policy and by the media store's `filenameRefusal`
 * (`media/mediaKinds.ts`), so a name refused for its length reads the same
 * sentence wherever it is refused.
 *
 * `ext` is the extension as `sanitizedExtension` keeps it, which is capped, so
 * the length is passed separately: `extensionLength` of the same name, the
 * number of characters the uploader actually typed. A capped extension is shown
 * with an ellipsis so the name and the number agree.
 */
export function extensionTooLongMessage(ext: string, length: number): string {
  const shown = length > ext.length ? `${ext}…` : ext;
  return `File extensions can be at most ${MAX_EXT_LENGTH} letters or digits (.${shown} is ${length}).`;
}

/** The extension's letters and digits, lowercased, before any cap. */
function extensionChars(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * How long `name`'s extension is before `sanitizedExtension` caps it — what a
 * refusal for length should report, since the capped one never exceeds
 * `MAX_EXTENSION_LENGTH`.
 */
export function extensionLength(name: string): number {
  return extensionChars(name).length;
}

/**
 * The extension `sanitizeFilename` keeps for `name` — lowercase letters and
 * digits, capped — or `''` when it keeps none. A leading dot does not start an
 * extension (`.gitignore` is a name). `validateFile` asks the same function, so
 * what it checks is exactly what gets stored — and so does the media store
 * (`media/mediaKinds.ts`), so "has an extension" means one thing everywhere.
 */
export function sanitizedExtension(name: string): string {
  return extensionChars(name).slice(0, MAX_EXTENSION_LENGTH);
}

/**
 * Sanitize a filename for safe storage.
 *
 * Lowercase ASCII letters, digits and dashes for the base; lowercase letters and
 * digits for the extension (dropped when nothing is left of it). A leading dot
 * does not start an extension — `.gitignore` is a name, as the delivery Worker
 * reads it too. A base that sanitizes to nothing (`講義.pdf`) becomes `file`.
 *
 * @returns the sanitized name with a timestamp prefix for uniqueness
 */
export function sanitizeFilename(filename: string): string {
  const name = (
    String(filename ?? '')
      .split(/[/\\]/)
      .pop() ?? ''
  ).trim();
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;

  const ext = sanitizedExtension(name);
  const baseName = hasExt ? name.slice(0, dot) : name;

  // Sanitize: lowercase, replace spaces and special chars with dashes
  const sanitized =
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) // Limit length
      .replace(/-$/, '') || 'file';

  // Add timestamp prefix for uniqueness
  const timestamp = Date.now();

  return `${timestamp}-${sanitized}${ext ? `.${ext}` : ''}`;
}
