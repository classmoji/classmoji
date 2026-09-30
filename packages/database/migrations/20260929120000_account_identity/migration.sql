-- Git identity moves from users to accounts.
--
-- A user can now hold several accounts (Github, GitLab, email+password), so the
-- provider username, provider email and provider avatar live on the account
-- row. users keeps the verified contact email (also the password sign-in email)
-- and the displayed avatar.

-- 0. Emails that differ only by case: the same person signed up twice with two
--    Github accounts. better-auth lowercases emails, so only one row can keep
--    the address. It stays with the account in use (classroom memberships,
--    then sessions, then the oldest); the others keep it as their Github
--    account's email (via provider_email, copied onto the account below).
WITH ranked AS (
  SELECT u."id",
         ROW_NUMBER() OVER (
           PARTITION BY LOWER(u."email")
           ORDER BY (SELECT COUNT(*) FROM "classroom_memberships" m WHERE m."user_id" = u."id") DESC,
                    (SELECT COUNT(*) FROM "sessions" s WHERE s."user_id" = u."id") DESC,
                    u."created_at" ASC,
                    u."id" ASC
         ) AS rn
  FROM "users" u
  WHERE u."email" IS NOT NULL
    AND LOWER(u."email") IN (
      SELECT LOWER("email") FROM "users" WHERE "email" IS NOT NULL
      GROUP BY LOWER("email") HAVING COUNT(*) > 1
    )
)
UPDATE "users" u
SET "provider_email" = COALESCE(u."provider_email", u."email"),
    "email" = NULL
FROM ranked
WHERE u."id" = ranked."id" AND ranked.rn > 1;

-- 1. New account columns.
ALTER TABLE "accounts" ADD COLUMN "email" TEXT;
ALTER TABLE "accounts" ADD COLUMN "image" TEXT;

-- 2. Backfill the provider account each user signed up with (null provider =
--    legacy Github user; same join as 20260926010000_account_username). A user
--    can hold several accounts on that provider (a Github account swapped in
--    later), so the stored profile goes to one: the account matching the
--    user's provider id, else the one in use (it has a token), else the most
--    recently updated. The others learn their username at their next sign-in.
WITH primary_accounts AS (
  SELECT a."id" AS account_id, u."id" AS user_id,
         ROW_NUMBER() OVER (
           PARTITION BY a."user_id"
           ORDER BY (a."account_id" = u."provider_id") DESC,
                    (a."access_token" IS NOT NULL) DESC,
                    a."updated_at" DESC
         ) AS rn
  FROM "accounts" a
  JOIN "users" u ON u."id" = a."user_id"
  WHERE a."provider_id" = LOWER(COALESCE(u."provider"::text, 'GITHUB'))
)
UPDATE "accounts" a
SET "username" = CASE WHEN p.rn = 1 THEN COALESCE(a."username", u."login") END,
    "email"    = CASE WHEN p.rn = 1 THEN u."provider_email" END,
    "image"    = CASE
                   WHEN p.rn <> 1 THEN NULL
                   WHEN u."image" IS NOT NULL THEN u."image"
                   WHEN a."provider_id" = 'github' AND u."provider_id" IS NOT NULL
                     THEN 'https://avatars.githubusercontent.com/u/' || u."provider_id" || '?v=4'
                 END
FROM primary_accounts p
JOIN "users" u ON u."id" = p.user_id
WHERE a."id" = p.account_id;

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

-- 5. One username per provider: keep the account in use (it has a token),
--    then the most recently updated.
UPDATE "accounts" SET "username" = NULL
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (
      PARTITION BY "provider_id", "username"
      ORDER BY ("access_token" IS NOT NULL) DESC, "updated_at" DESC
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

-- 7. users.email is now better-auth's email: lowercase it. Every address on
--    file was accepted under the old rules (registration code, invite link,
--    or entered by course staff), so existing users are not asked to verify it
--    again; only accounts created from now on go through verification.
UPDATE "users" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");
UPDATE "users" SET "emailVerified" = ("email" IS NOT NULL);

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
