/**
 * The render path must not pull the AWS SDK in behind it.
 *
 * Every page and deck render imports the delivery resolver, which imports the
 * media lookups — and for a while that chain ended at `media.service.ts` and
 * so at `@aws-sdk/client-s3` and its transitive packages, in two apps that only
 * ever render and never upload. The split that fixed it is invisible in any
 * behavioural test: the reads keep working either way. What can be asserted is
 * whether the module was ever LOADED, which is what this file does.
 *
 * The second case is the guard against a vacuous first one: if the mock were
 * wrong, or the spy never wired up, nothing here would fail — so the write half
 * is imported deliberately at the end and must trip exactly the counter the
 * read half left at zero.
 */

import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ s3: 0 }));

function command(name: string) {
  return class {
    readonly __name = name;
    constructor(public input: Record<string, unknown>) {}
  };
}

vi.mock('@aws-sdk/client-s3', () => {
  loads.s3 += 1;
  return {
    S3Client: class {
      async send() {
        return {};
      }
    },
    AbortMultipartUploadCommand: command('AbortMultipartUpload'),
    CompleteMultipartUploadCommand: command('CompleteMultipartUpload'),
    CreateMultipartUploadCommand: command('CreateMultipartUpload'),
    DeleteObjectCommand: command('DeleteObject'),
    HeadObjectCommand: command('HeadObject'),
    UploadPartCommand: command('UploadPart'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => {
  loads.s3 += 1;
  return { getSignedUrl: async () => 'https://r2.example/signed' };
});

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

describe('the media barrel', () => {
  it('is importable without the S3 client', async () => {
    const media = await import('../index.ts');
    // The read half is all there.
    expect(typeof media.servedVariant).toBe('function');
    expect(typeof media.mediaRef).toBe('function');
    expect(typeof media.isMediaConfigured).toBe('function');
    // And so are the writes — as facades, which is the whole point: naming one
    // must not load it.
    expect(typeof media.createUpload).toBe('function');
    expect(loads.s3).toBe(0);
  });
});

describe('the delivery resolver', () => {
  it('does not load the S3 client', async () => {
    const delivery = await import('../../classmoji/contentDelivery.service.ts');
    expect(typeof delivery.resolveAssetUrl).toBe('function');
    expect(loads.s3).toBe(0);
  });
});

describe('the write half', () => {
  it('is what loads the S3 client, when something reaches for it', async () => {
    await import('../media.service.ts');
    expect(loads.s3).toBeGreaterThan(0);
  });
});
