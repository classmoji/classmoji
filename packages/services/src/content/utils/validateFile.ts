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
 * `sanitizeFilename` then reduces it to lowercase ASCII — extension included,
 * which matters once any extension is allowed, because the extension lands in
 * the path verbatim.
 */

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
} {
  if (size > MAX_FILE_SIZE) {
    return { valid: false, error: repoFileTooLargeMessage() };
  }

  const name = typeof filename === 'string' ? filename.trim() : '';
  if (/[/\\]/.test(name)) {
    return { valid: false, error: 'File names cannot contain "/" or "\\".' };
  }
  if (!name || /^\.+$/.test(name)) {
    return { valid: false, error: 'That file needs a name.' };
  }

  if (fileTypes === 'any') return { valid: true };

  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    };
  }

  return { valid: true };
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

  const ext = hasExt
    ? name
        .slice(dot + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, MAX_EXTENSION_LENGTH)
    : '';
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
