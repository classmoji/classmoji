/**
 * Whether this deployment has a media bucket, and which one.
 *
 * Split out of `r2Client.ts` for one reason: every render imports the media
 * barrel (the delivery resolver needs `servedVariant` and the lookups), and a
 * loader deciding whether to show an upload button needs `isMediaConfigured` —
 * but neither has any business pulling `@aws-sdk/client-s3` and its transitive
 * packages into a module graph that renders pages. The four env vars are a
 * string question with a string answer; only the CLIENT needs the SDK.
 *
 * `isMediaConfigured()` is the switch every entry point checks first, and it is
 * deliberately all-or-nothing: three of four env vars is not a degraded mode,
 * it is a misconfiguration that would fail at the first request with an opaque
 * signature error instead of an honest "media is not configured here". Unset is
 * the normal state for a contributor's laptop and for any deployment that has
 * not been given a bucket — the media routes answer 503 and the UI says so.
 */

/** Every env var the client needs. All four, or none of it works. */
export function mediaEnv(): {
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
  return mediaEnv() !== null;
}

/** The bucket this deployment writes to, or null when unconfigured. */
export function mediaBucket(): string | null {
  return mediaEnv()?.bucket ?? null;
}
