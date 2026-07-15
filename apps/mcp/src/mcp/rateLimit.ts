/**
 * Per-user, per-tool in-memory token-bucket rate limiting (S6).
 *
 * Enforced uniformly in the registry layer (src/mcp/registry.ts) BEFORE any
 * handler runs, so every Phase 2 tool/resource gets it for free. Buckets are
 * keyed `${userId}:${toolName}`; each tool may override the default config
 * via its `rateLimit` field.
 *
 * In-memory is intentional for v1 (single-process Fly app). If the server is
 * ever scaled horizontally, swap this module for a shared store — the
 * interface is the seam.
 */

export interface RateLimitConfig {
  /** Maximum burst size (bucket capacity). */
  capacity: number;
  /** Tokens added back per second (sustained rate). */
  refillPerSecond: number;
}

/** Default: bursts of 20 calls, sustained 30 calls/minute per user per tool. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  capacity: 20,
  refillPerSecond: 0.5,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

// Bound memory: sweep buckets idle for >10 minutes once the map grows large.
const SWEEP_THRESHOLD = 10_000;
const IDLE_MS = 10 * 60 * 1000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefillMs > IDLE_MS) buckets.delete(key);
  }
}

/**
 * Attempt to consume one token from the bucket for `key`.
 * @returns true if the call is allowed, false if rate-limited.
 */
export function tryConsume(key: string, config: RateLimitConfig = DEFAULT_RATE_LIMIT): boolean {
  const now = Date.now();
  if (buckets.size > SWEEP_THRESHOLD) sweep(now);

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.capacity, lastRefillMs: now };
    buckets.set(key, bucket);
  } else {
    const elapsedSeconds = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(
      config.capacity,
      bucket.tokens + elapsedSeconds * config.refillPerSecond
    );
    bucket.lastRefillMs = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Test helper: clear all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
