import { assertClassroomId, assertTier } from './canonical.ts';
import type { Tier } from './types.ts';

const HOUR = 3600;
const DAY = 86400;

export interface TierPolicy {
  /** Bucket length in seconds, or null when the tier uses an exact TTL. */
  bucketSeconds: number | null;
  /** Exact TTL in seconds, or null when the tier is bucketed. */
  ttlSeconds: number | null;
  /** How far past `exp` a signature is still accepted on verify. */
  graceSeconds: number;
}

export const TIER_POLICY: Readonly<Record<Tier, TierPolicy>> = {
  public: { bucketSeconds: 30 * DAY, ttlSeconds: null, graceSeconds: 6 * HOUR },
  enrolled: { bucketSeconds: 7 * DAY, ttlSeconds: null, graceSeconds: 6 * HOUR },
  draft: { bucketSeconds: null, ttlSeconds: 4 * HOUR, graceSeconds: 5 * 60 },
};

/**
 * FNV-1a, 32-bit. Used only to stagger bucket boundaries across classrooms —
 * it is not a security primitive and never feeds the signature.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Seconds into a bucket period where this classroom's boundaries fall. */
export function bucketOffset(classroomId: string, bucketSeconds: number): number {
  return fnv1a32(classroomId) % bucketSeconds;
}

/**
 * Expiry for a freshly minted URL, in unix seconds.
 *
 * Bucketed tiers round up to the end of the classroom's current bucket, so
 * every URL minted inside one bucket is byte-identical and cacheable. Draft is
 * an exact `now + 4h`. The result is always strictly greater than `now`.
 */
export function bucketExpiry(tier: Tier, classroomId: string, now: number): number {
  assertTier(tier);
  assertClassroomId(classroomId);
  const policy = TIER_POLICY[tier];
  const seconds = Math.floor(now);

  if (policy.bucketSeconds === null) return seconds + (policy.ttlSeconds ?? 0);

  const length = policy.bucketSeconds;
  const offset = bucketOffset(classroomId, length);
  const index = Math.floor((seconds - offset) / length);
  return offset + (index + 1) * length;
}

/** Grace window, in seconds, applied to an expired signature on verify. */
export function graceFor(tier: Tier): number {
  return TIER_POLICY[tier].graceSeconds;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
