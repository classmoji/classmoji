-- Usernames are unique per git server, not per provider: `jdoe` on gitlab.com
-- and `jdoe` on a school's self-managed GitLab are two different people. A
-- self-managed account's id is stored as `<instance id>:<id>`
-- (scopeGitlabId), so its instance is recoverable from it.

-- 1. The server a GitLab account lives on; "" for gitlab.com and every other
--    provider (not null, so the unique key below still covers them).
ALTER TABLE "accounts" ADD COLUMN "gitlab_instance_id" TEXT NOT NULL DEFAULT '';

UPDATE "accounts"
SET "gitlab_instance_id" = split_part("account_id", ':', 1)
WHERE "provider_id" = 'gitlab' AND position(':' IN "account_id") > 0;

-- 2. One username per provider AND server. Strictly looser than the key it
--    replaces, so no existing row can violate it.
DROP INDEX IF EXISTS "accounts_provider_id_username_key";
CREATE UNIQUE INDEX "accounts_provider_id_gitlab_instance_id_username_key"
  ON "accounts"("provider_id", "gitlab_instance_id", "username");
