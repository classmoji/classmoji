-- CreateEnum
CREATE TYPE "BillingEventAction" AS ENUM ('CHECKOUT_STARTED', 'PORTAL_OPENED', 'PRO_GRANTED', 'PLAN_UPDATED', 'MOVED_TO_FREE');

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" "BillingEventAction" NOT NULL,
    "source" TEXT NOT NULL,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "stripe_event_id" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_events_user_id_created_at_idx" ON "billing_events"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
