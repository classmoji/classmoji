-- Remove unused ENTERPRISE value from SubscriptionTier enum.
-- Defensively backfill any ENTERPRISE rows to FREE before dropping the enum value
-- so this migration is safe on any environment where the value was ever used.
UPDATE "subscriptions" SET "tier" = 'FREE' WHERE "tier" = 'ENTERPRISE';
ALTER TYPE "SubscriptionTier" RENAME TO "SubscriptionTier_old";
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO');
ALTER TABLE "subscriptions"
  ALTER COLUMN "tier" DROP DEFAULT,
  ALTER COLUMN "tier" TYPE "SubscriptionTier" USING ("tier"::text::"SubscriptionTier"),
  ALTER COLUMN "tier" SET DEFAULT 'FREE';
DROP TYPE "SubscriptionTier_old";
