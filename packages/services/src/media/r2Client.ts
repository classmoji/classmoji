import { S3Client } from '@aws-sdk/client-s3';
import { mediaEnv } from './mediaConfig.ts';

/**
 * The S3 seam onto Cloudflare R2.
 *
 * R2 speaks the S3 API, so the ordinary AWS SDK works against it with two
 * changes: the endpoint is the account's own `r2.cloudflarestorage.com` host,
 * and the region is the literal string `auto` because R2 has no regions.
 *
 * ## This file is the AWS SDK boundary
 *
 * It is the only module in `src/media/` that imports `@aws-sdk/client-s3`
 * besides `media.service.ts`, and both are reachable ONLY through the barrel's
 * lazy write half. The question "is media configured here" lives next door in
 * `mediaConfig.ts` precisely so that a page render can ask it without dragging
 * the SDK into its bundle — see `index.ts`.
 */

/**
 * One client per process, rebuilt when the credentials change.
 *
 * Cached because an S3Client holds a connection pool and the credential
 * resolution chain, and building one per request would throw both away. Keyed
 * on the env values so a test that swaps credentials mid-run gets a fresh
 * client instead of the previous one's signer.
 */
let cached: { key: string; client: S3Client } | null = null;

export function r2Client(): S3Client | null {
  const settings = mediaEnv();
  if (!settings) {
    cached = null;
    return null;
  }

  const key = `${settings.accountId}|${settings.accessKeyId}|${settings.bucket}`;
  if (cached?.key === key) return cached.client;

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // Since v3.729 the SDK adds a CRC32 checksum header to every upload by
    // default and signs it into presigned URLs. A browser PUTting a part cannot
    // reproduce that header, so the request arrives without it and the
    // signature does not match — the upload fails with a signature error that
    // says nothing about checksums. `WHEN_REQUIRED` keeps the checksum for the
    // operations that genuinely need one and leaves UploadPart alone.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  cached = { key, client };
  return client;
}

/** Drop the cached client. For tests that swap credentials between cases. */
export function resetR2Client(): void {
  cached = null;
}
