-- Remove unused ENTERPRISE value from SubscriptionTier enum.
-- No data migration needed: zero rows have tier = 'ENTERPRISE' (verified on dev).
ALTER TYPE "SubscriptionTier" RENAME TO "SubscriptionTier_old";
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO');
ALTER TABLE "subscriptions"
  ALTER COLUMN "tier" DROP DEFAULT,
  ALTER COLUMN "tier" TYPE "SubscriptionTier" USING ("tier"::text::"SubscriptionTier"),
  ALTER COLUMN "tier" SET DEFAULT 'FREE';
DROP TYPE "SubscriptionTier_old";
