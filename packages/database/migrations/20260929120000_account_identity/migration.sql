-- Git identity moves from users to accounts.
--
-- A user can now hold several accounts (Github, GitLab, email+password), so the
-- provider username, provider email and provider avatar live on the account
-- row. users keeps the verified contact email (also the password sign-in email)
-- and the displayed avatar.

-- 0. Preflight: better-auth lowercases emails on sign-up and lookup, so two rows
--    differing only by case would collide once normalized. Fix by hand first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "users" WHERE "email" IS NOT NULL
    GROUP BY LOWER("email") HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'users.email has case-insensitive duplicates; resolve them before migrating';
  END IF;
END $$;

-- 1. New account columns.
ALTER TABLE "accounts" ADD COLUMN "email" TEXT;
ALTER TABLE "accounts" ADD COLUMN "image" TEXT;

-- 2. Backfill the provider account each user signed up with (null provider =
--    legacy Github user; same join as 20260926010000_account_username).
UPDATE "accounts" a
SET "username" = COALESCE(a."username", u."login"),
    "email"    = u."provider_email",
    "image"    = CASE
                   WHEN u."image" IS NOT NULL THEN u."image"
                   WHEN a."provider_id" = 'github' AND u."provider_id" IS NOT NULL
                     THEN 'https://avatars.githubusercontent.com/u/' || u."provider_id" || '?v=4'
                 END
FROM "users" u
WHERE a."user_id" = u."id"
  AND a."provider_id" = LOWER(COALESCE(u."provider"::text, 'GITHUB'));

-- 3. Users with a provider id but no account row (GitHub Classroom import,
--    example classroom personas, pre-provisioned staff): give them a token-less
--    account so their git identity survives, and so better-auth's
--    (provider_id, account_id) lookup lands on them at their first sign-in.
INSERT INTO "accounts" ("id", "user_id", "account_id", "provider_id", "username", "email", "image", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       u."id",
       u."provider_id",
       LOWER(COALESCE(u."provider"::text, 'GITHUB')),
       u."login",
       u."provider_email",
       CASE
         WHEN u."image" IS NOT NULL THEN u."image"
         WHEN COALESCE(u."provider"::text, 'GITHUB') = 'GITHUB'
           THEN 'https://avatars.githubusercontent.com/u/' || u."provider_id" || '?v=4'
       END,
       NOW(), NOW()
FROM "users" u
WHERE u."provider_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" a
    WHERE a."user_id" = u."id"
      AND a."provider_id" = LOWER(COALESCE(u."provider"::text, 'GITHUB'))
  )
ON CONFLICT ("provider_id", "account_id") DO NOTHING;

-- 4. Users known only by a Github username (no provider id): a placeholder
--    account the first Github sign-in with that username claims (the sign-in
--    rewrites account_id to the real Github id).
INSERT INTO "accounts" ("id", "user_id", "account_id", "provider_id", "username", "image", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       u."id",
       'unresolved:' || u."id",
       'github',
       u."login",
       u."image",
       NOW(), NOW()
FROM "users" u
WHERE u."provider_id" IS NULL
  AND u."login" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."provider_id" = 'github'
  );

-- 5. One username per provider: keep the most recently updated holder.
UPDATE "accounts" SET "username" = NULL
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (
      PARTITION BY "provider_id", "username" ORDER BY "updated_at" DESC
    ) AS rn
    FROM "accounts" WHERE "username" IS NOT NULL
  ) ranked
  WHERE rn > 1
);
CREATE UNIQUE INDEX "accounts_provider_id_username_key" ON "accounts"("provider_id", "username");

-- 6. users.image is the displayed avatar.
UPDATE "users"
SET "image" = 'https://avatars.githubusercontent.com/u/' || "provider_id" || '?v=4'
WHERE "image" IS NULL
  AND "provider_id" IS NOT NULL
  AND COALESCE("provider"::text, 'GITHUB') = 'GITHUB';

-- 7. users.email is now better-auth's email: lowercase it, and mark it verified
--    for users who registered it (registration required a code or an invite,
--    and only runs after a real sign-in). Emails typed in by staff for users
--    who never signed in stay unverified and are confirmed at registration.
UPDATE "users" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");
UPDATE "users" u SET "emailVerified" = TRUE
WHERE u."email" IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."access_token" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "sessions" s WHERE s."user_id" = u."id")
  );

-- 8. Report (not fail): classroom members with no Github username can't be
--    added to repos until they connect Github.
DO $$
DECLARE missing INTEGER;
BEGIN
  SELECT COUNT(DISTINCT m."user_id") INTO missing
  FROM "classroom_memberships" m
  WHERE NOT EXISTS (
    SELECT 1 FROM "accounts" a
    WHERE a."user_id" = m."user_id" AND a."username" IS NOT NULL
  );
  IF missing > 0 THEN
    RAISE NOTICE '% classroom member(s) have no git username', missing;
  END IF;
END $$;

-- 9. Drop the identity columns from users.
DROP INDEX IF EXISTS "users_login_key";
DROP INDEX IF EXISTS "users_provider_provider_id_key";
DROP INDEX IF EXISTS "users_provider_login_idx";
ALTER TABLE "users" DROP COLUMN "login",
                    DROP COLUMN "provider",
                    DROP COLUMN "provider_id",
                    DROP COLUMN "provider_email";
