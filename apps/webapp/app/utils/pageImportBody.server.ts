/**
 * The body of a page import — markdown plus its images — read with a cap, and
 * each image checked against the repository's per-file ceiling.
 *
 * Both page-import actions (`admin.$class.pages.new` for one page,
 * `api.pages.batch` once per page of a batch) read the body only after their
 * classroom gate, through `readLimitedFormData`, so a stranger never makes the
 * process hold a byte and a signed-in caller cannot make it hold more than
 * `PAGE_IMPORT_BODY_MAX_BYTES`. The per-image check then runs on the parsed
 * parts, before anything is committed: the import's files go to GitHub in ONE
 * commit, and one file GitHub refuses as too large would refuse them all.
 */

import {
  REPO_REST_MAX_BYTES,
  formatMegabytes,
  repoFileTooLargeMessage,
} from '@classmoji/utils/repo-limits';
import {
  UploadTooLargeError,
  readLimitedFormData,
  uploadBodyLimit,
} from '@classmoji/utils/upload-limit';

/**
 * The most one page import may send: 150 MB, the same bound as the slides.com
 * ZIP import. A page's markdown and images arrive in one request, so this is a
 * cap on the whole page, while each image separately stays under
 * `REPO_REST_MAX_BYTES`.
 */
export const PAGE_IMPORT_BODY_MAX_BYTES = 150 * 1024 * 1024;

/** What a person reads when the whole import is over the body cap. */
export const PAGE_IMPORT_TOO_LARGE_MESSAGE =
  `This import is larger than ${formatMegabytes(PAGE_IMPORT_BODY_MAX_BYTES)}. ` +
  'Split it into smaller pages and try again.';

/**
 * The import's form, or null when the body was over the cap. Anything else the
 * parser throws (a truncated part, a missing boundary) is rethrown.
 */
export async function readPageImportForm(request: Request): Promise<FormData | null> {
  try {
    return await readLimitedFormData(request, uploadBodyLimit(PAGE_IMPORT_BODY_MAX_BYTES));
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) return null;
    throw error;
  }
}

/**
 * The refusal for the first file over the repository cap, naming it — or null
 * when every file fits. Strings in the list (a stray text field) are ignored.
 */
export function oversizedImportFileMessage(files: Array<FormDataEntryValue>): string | null {
  for (const file of files) {
    if (typeof file !== 'string' && file.size > REPO_REST_MAX_BYTES) {
      return repoFileTooLargeMessage(file.name);
    }
  }
  return null;
}
