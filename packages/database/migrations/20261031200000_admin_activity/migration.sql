-- Platform admin redesign: when people first signed in and were last seen,
-- and an audit table for what platform admins do in apps/admin.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "first_sign_in_at" TIMESTAMP(3),
ADD COLUMN "last_seen_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");
CREATE INDEX "users_first_sign_in_at_idx" ON "users"("first_sign_in_at");

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "classroom_id" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");
CREATE INDEX "platform_audit_logs_actor_id_idx" ON "platform_audit_logs"("actor_id");
CREATE INDEX "platform_audit_logs_target_id_idx" ON "platform_audit_logs"("target_id");

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill. last_seen_at: the newest activity of a session the person used
-- themselves (sessions only move once their cookie cache lapses, so this is
-- coarse, and nothing exists for people whose sessions are gone).
UPDATE "users" u
SET "last_seen_at" = s.seen
FROM (
  SELECT "user_id", max("updated_at") AS seen
  FROM "sessions"
  WHERE "impersonated_by" IS NULL
  GROUP BY "user_id"
) s
WHERE s."user_id" = u."id";

-- first_sign_in_at: the oldest non-impersonated session still on file, else
-- created_at for anyone who holds a sign-in credential (an OAuth token or a
-- password). Roster placeholders nobody claimed stay null. For a placeholder
-- claimed before this migration whose sessions are gone, created_at is the
-- provisioning date: an approximation, but only for history before today.
UPDATE "users" u
SET "first_sign_in_at" = COALESCE(
  (SELECT min(s."created_at") FROM "sessions" s
   WHERE s."user_id" = u."id" AND s."impersonated_by" IS NULL),
  u."created_at"
)
WHERE EXISTS (
  SELECT 1 FROM "accounts" a
  WHERE a."user_id" = u."id"
    AND (a."access_token" IS NOT NULL OR a."provider_id" = 'credential')
) OR EXISTS (
  SELECT 1 FROM "sessions" s
  WHERE s."user_id" = u."id" AND s."impersonated_by" IS NULL
);
