/**
 * A part URL carries its length in the signature.
 *
 * `media.service.test.ts` mocks the presigner, so it can only show that the
 * service ASKS for `ContentLength` to be signed. Whether the real presigner
 * then puts `content-length` into `X-Amz-SignedHeaders` is the SDK's
 * behaviour, and it is the whole of the rule: a URL whose signature does not
 * cover the length would take a part of any size. So this file runs the real
 * `@aws-sdk/s3-request-presigner` against dummy credentials — signing is local
 * arithmetic, nothing leaves the process — and reads the URL it produces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({ mediaObject: { findFirst: (...a: unknown[]) => findFirst(...a) } }),
}));
vi.mock('../../classmoji/subscription.service.ts', () => ({
  getProStateForClassroomId: async () => ({ isPro: true }),
}));

const { signParts } = await import('../media.service.ts');
const { PART_SIZE_BYTES } = await import('../mediaQuota.ts');
const { resetR2Client } = await import('../r2Client.ts');

const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

beforeEach(() => {
  process.env.MEDIA_R2_ACCOUNT_ID = 'acct';
  process.env.MEDIA_R2_ACCESS_KEY_ID = 'key';
  process.env.MEDIA_R2_SECRET_ACCESS_KEY = 'secret';
  process.env.MEDIA_R2_BUCKET = 'classmoji-media-test';
  resetR2Client();
  findFirst.mockResolvedValue({
    id: MEDIA_ID,
    classroom_id: CLASSROOM_ID,
    ext: 'mp4',
    size_bytes: BigInt(PART_SIZE_BYTES + 10),
    status: 'UPLOADING',
    upload_id: 'up-1',
    created_at: new Date(),
  });
});

afterEach(() => {
  delete process.env.MEDIA_R2_ACCOUNT_ID;
  delete process.env.MEDIA_R2_ACCESS_KEY_ID;
  delete process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  delete process.env.MEDIA_R2_BUCKET;
  resetR2Client();
});

describe('a presigned part URL', () => {
  it('signs content-length, so a PUT of any other size is refused by R2', async () => {
    const { urls } = await signParts({
      classroom: { id: CLASSROOM_ID },
      mediaId: MEDIA_ID,
      partNumbers: [1, 2],
    });

    for (const { url } of urls) {
      const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
      expect(signed.split(';')).toContain('content-length');
    }
  });
});
