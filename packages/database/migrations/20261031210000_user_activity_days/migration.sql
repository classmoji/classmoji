-- One row per person per day they used the webapp themselves (never while
-- impersonated): weekly-active and retention history for the admin app.

-- CreateTable
CREATE TABLE "user_activity_days" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,

    CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("user_id","day")
);

-- CreateIndex
CREATE INDEX "user_activity_days_day_idx" ON "user_activity_days"("day");

-- AddForeignKey
ALTER TABLE "user_activity_days" ADD CONSTRAINT "user_activity_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed today's and earlier days we can still see: each non-impersonated
-- session's last activity counts as a day of use.
INSERT INTO "user_activity_days" ("user_id", "day")
SELECT DISTINCT "user_id", ("updated_at" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
FROM "sessions"
WHERE "impersonated_by" IS NULL
ON CONFLICT DO NOTHING;
