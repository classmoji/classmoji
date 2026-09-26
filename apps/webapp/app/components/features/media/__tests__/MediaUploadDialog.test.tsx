/**
 * The sentence an uploader reads when an upload fails.
 *
 * `messageFor` is the whole of this dialog's error behaviour: the service
 * decides WHY an upload was refused, and this decides what that means to the
 * person holding the file. The case worth guarding is a code with no branch —
 * it falls through to "check your connection", which sends someone to their
 * router over a classroom that is not on Pro or cannot serve content at all.
 */

import { describe, expect, it } from 'vitest';
import { messageFor } from '../MediaUploadDialog';
import type { MultipartUploadError } from '@classmoji/ui-components';
import type { QuotaSummary } from '../mediaUploadOptions';

const GiB = 1024 ** 3;

const quota: QuotaSummary = {
  usedBytes: 2 * GiB,
  quotaBytes: 10 * GiB,
  perFileBytes: 2 * GiB,
};

/** A `MultipartUploadError` as the dialog receives it — only `code` is read. */
const failure = (code: string, extra: Record<string, unknown> = {}) =>
  ({ code, message: 'x', ...extra }) as unknown as MultipartUploadError;

const fallback = messageFor(failure('NETWORK'), quota);

describe('messageFor', () => {
  it('names the classroom, not the connection, when content delivery is not up', () => {
    const message = messageFor(failure('DELIVERY_REQUIRED'), quota);

    expect(message).toBe(
      "This class isn't set up to serve content yet, so media can't be uploaded."
    );
    expect(message).not.toBe(fallback);
  });

  it('asks for a retry when the finished object could not be read back', () => {
    const message = messageFor(failure('VERIFY_FAILED'), quota);

    expect(message).toBe("The upload couldn't be verified. Try again.");
    expect(message).not.toBe(fallback);
  });

  it('leaves every other code saying what it already said', () => {
    expect(messageFor(failure('NOT_CONFIGURED'), quota)).toContain('not configured');
    expect(messageFor(failure('PRO_REQUIRED'), quota)).toContain('Pro');
    expect(messageFor(failure('KIND_NOT_ALLOWED'), quota)).toContain("can't be uploaded");
    expect(messageFor(failure('SIZE_MISMATCH'), quota)).toContain('discarded');
    expect(messageFor(failure('NOT_FOUND'), quota)).toContain('no longer valid');
    expect(messageFor(failure('BAD_STATE'), quota)).toContain('no longer valid');
  });

  it('puts the server numbers in the quota message, and the page numbers when it has none', () => {
    expect(
      messageFor(failure('QUOTA_EXCEEDED', { usedBytes: 9 * GiB, quotaBytes: 10 * GiB }), quota)
    ).toContain('9.0 GB of 10 GB');
    expect(messageFor(failure('QUOTA_EXCEEDED'), quota)).toContain('2.0 GB of 10 GB');
  });
});
