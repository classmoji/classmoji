/**
 * Per-user token buckets for the feedback board, so one account cannot flood
 * it. In memory, like apps/mcp/src/mcp/rateLimit.ts: the webapp runs on one
 * Fly machine. If it ever scales out, this needs a shared store.
 */

interface Limit {
  /** Burst size. */
  capacity: number;
  /** Tokens returned per hour. */
  perHour: number;
}

export const FEEDBACK_LIMITS = {
  post: { capacity: 5, perHour: 10 },
  comment: { capacity: 20, perHour: 60 },
  vote: { capacity: 60, perHour: 600 },
} satisfies Record<string, Limit>;

const buckets = new Map<string, { tokens: number; at: number }>();
const IDLE_MS = 2 * 60 * 60 * 1000;

/** True when the user may act now; false means slow down. */
export function allowFeedbackAction(userId: string, kind: keyof typeof FEEDBACK_LIMITS): boolean {
  const limit = FEEDBACK_LIMITS[kind];
  const key = `${kind}:${userId}`;
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now - b.at > IDLE_MS) buckets.delete(k);
  }
  const bucket = buckets.get(key) ?? { tokens: limit.capacity, at: now };
  bucket.tokens = Math.min(
    limit.capacity,
    bucket.tokens + ((now - bucket.at) / 3_600_000) * limit.perHour
  );
  bucket.at = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.set(key, bucket);
  return allowed;
}
