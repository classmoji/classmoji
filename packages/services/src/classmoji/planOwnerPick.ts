/**
 * Which accepted owner a classroom's Free-plan slot belongs to, decided from
 * rows the caller already loaded. No imports, so the Pro resolver
 * (`subscription.service.ts`) and the plan-owner service can both use it
 * without importing each other.
 *
 * The stored `plan_owner_id` wins while that person is still an accepted
 * OWNER. Otherwise (never set, the user was deleted, they left by a path that
 * did not hand it on) the oldest accepted owner stands in. No accepted owner
 * means nobody.
 *
 * `acceptedOwnerIds` must be ordered oldest first, by membership `created_at`
 * then `id`, so the fallback is the same on every call.
 */
export function pickEffectivePlanOwner(
  planOwnerId: string | null | undefined,
  acceptedOwnerIds: readonly string[]
): string | null {
  if (planOwnerId && acceptedOwnerIds.includes(planOwnerId)) return planOwnerId;
  return acceptedOwnerIds[0] ?? null;
}
