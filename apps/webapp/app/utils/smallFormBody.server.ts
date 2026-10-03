/**
 * The body of an action that posts a few short text fields — ids, a status, a
 * title — read through the byte-counting reader rather than `request.formData()`.
 *
 * Those actions carry no file, so their cap is small: whatever a caller sends
 * beyond it is refused as it streams instead of being buffered first. Read only
 * after the action's own gate, like every other body in this app.
 */

import { UploadTooLargeError, readLimitedFormData } from '@classmoji/utils/upload-limit';

/** The most a short-field form may send. */
export const SMALL_FORM_MAX_BYTES = 64 * 1024;

/** What a caller is told when it sent more than that. */
export const SMALL_FORM_TOO_LARGE_MESSAGE = 'Request body is too large.';

/** The form, or null when the body was over `SMALL_FORM_MAX_BYTES`. */
export async function readSmallForm(request: Request): Promise<FormData | null> {
  try {
    return await readLimitedFormData(request, SMALL_FORM_MAX_BYTES);
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) return null;
    throw error;
  }
}
