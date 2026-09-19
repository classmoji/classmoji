import { S3Client } from '@aws-sdk/client-s3';

/**
 * The S3 seam onto Cloudflare R2.
 *
 * R2 speaks the S3 API, so the ordinary AWS SDK works against it with two
 * changes: the endpoint is the account's own `r2.cloudflarestorage.com` host,
 * and the region is the literal string `auto` because R2 has no regions.
 *
 * ## Why this is the only file that knows the credentials exist
 *
 * `isMediaConfigured()` is the switch every entry point checks first, and it is
 * deliberately all-or-nothing: three of four env vars is not a degraded mode,
 * it is a misconfiguration that would fail at the first request with an opaque
 * signature error instead of an honest "media is not configured here". Unset is
 * the normal state for a contributor's laptop and for any deployment that has
 * not been given a bucket — the media routes answer 503 and the UI says so.
 */

/** Every env var the client needs. All four, or none of it works. */
function env(): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} | null {
  const accountId = process.env.MEDIA_R2_ACCOUNT_ID;
  const accessKeyId = process.env.MEDIA_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.MEDIA_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isMediaConfigured(): boolean {
  return env() !== null;
}

/** The bucket this deployment writes to, or null when unconfigured. */
export function mediaBucket(): string | null {
  return env()?.bucket ?? null;
}

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
  const settings = env();
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
