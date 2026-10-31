/**
 * Per-user token bucket for joining through invite links, so one account
 * cannot hammer Github with org invitations or try codes in bulk. In memory,
 * like feedbackRate.server.ts: the webapp runs on one Fly machine. If it ever
 * scales out, this needs a shared store.
 */

/** A burst of 10 joins, then 20 an hour. */
export const JOIN_LINK_RATE_LIMIT = { capacity: 10, perHour: 20 } as const;

const buckets = new Map<string, { tokens: number; at: number }>();
const IDLE_MS = 2 * 60 * 60 * 1000;

/** True when the user may join now; false means slow down. */
export function allowJoinLinkAttempt(userId: string): boolean {
  const { capacity, perHour } = JOIN_LINK_RATE_LIMIT;
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now - b.at > IDLE_MS) buckets.delete(k);
  }
  const bucket = buckets.get(userId) ?? { tokens: capacity, at: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 3_600_000) * perHour);
  bucket.at = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.set(userId, bucket);
  return allowed;
}
