-- Each connected provider account keeps its own username, so a user with both
-- Github and GitLab connected has both on record.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "username" TEXT;

-- Backfill: until now `users.login` was the username on the provider the user
-- signed up with (null provider = legacy Github user).
UPDATE "accounts" a
SET "username" = u."login"
FROM "users" u
WHERE a."user_id" = u."id"
  AND u."login" IS NOT NULL
  AND a."provider_id" = LOWER(COALESCE(u."provider"::text, 'GITHUB'));
