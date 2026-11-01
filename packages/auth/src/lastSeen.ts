import getPrisma from '@classmoji/database';

/**
 * Records that a person used the app themselves: `last_seen_at` now, and
 * `first_sign_in_at` if this is the first time. The platform admin app reads
 * both (activity, signups) instead of session rows, which move only when the
 * cookie cache lapses and vanish on sign-out.
 *
 * Never for an impersonated session: an admin viewing as someone is not that
 * person being active. Throttled per process to one write per user every
 * THROTTLE_MS, and never awaited by callers: a failed write must not fail a
 * request.
 */
const THROTTLE_MS = 10 * 60 * 1000;
const lastWrite = new Map<string, number>();

export const noteSeen = (
  userId: string | null | undefined,
  impersonatedBy: unknown,
  { force = false }: { force?: boolean } = {}
): void => {
  if (!userId || impersonatedBy) return;
  const now = Date.now();
  if (!force && now - (lastWrite.get(userId) ?? 0) < THROTTLE_MS) return;
  lastWrite.set(userId, now);
  // Bound the map: a long-lived process sees every user eventually.
  if (lastWrite.size > 50_000) lastWrite.clear();
  getPrisma()
    .$executeRaw`UPDATE "users" SET "last_seen_at" = now(), "first_sign_in_at" = COALESCE("first_sign_in_at", now()) WHERE "id" = ${userId}`
    .catch((error: unknown) => {
      lastWrite.delete(userId);
      console.warn('[auth] noteSeen failed:', error);
    });
};
