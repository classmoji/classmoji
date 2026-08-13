-- The classroom content repo name becomes a STORED, user-editable value
-- instead of being re-derived as content-{orgLogin}-{content_namespace} at
-- every call site. content_namespace stays as an internal identifier (and
-- keeps its per-org unique constraint); it no longer names any repo.

-- Add nullable so existing rows can be backfilled before the NOT NULL.
ALTER TABLE "classrooms" ADD COLUMN "content_repo" TEXT;

-- Backfill with the EXACT name the old derivation produced, so every existing
-- classroom keeps pointing at the repo it already has on GitHub. This is the
-- one place the legacy content-{orgLogin}-{content_namespace} pattern is still
-- written down; nothing derives it at runtime any more.
UPDATE "classrooms" c
SET "content_repo" = 'content-' || g."login" || '-' || c."content_namespace"
FROM "git_organizations" g
WHERE c."git_org_id" = g."id";

-- Defensive: a classroom whose org row is somehow missing (FK makes this
-- unreachable) still needs a value for the NOT NULL below.
UPDATE "classrooms"
SET "content_repo" = 'content-' || "content_namespace"
WHERE "content_repo" IS NULL;

ALTER TABLE "classrooms" ALTER COLUMN "content_repo" SET NOT NULL;

-- Two classrooms in one org sharing a content repo would share (and could
-- adopt, overwrite, or delete) each other's content. The backfill cannot
-- collide: it is a pure function of (login, content_namespace), and
-- [git_org_id, content_namespace] is already unique.
CREATE UNIQUE INDEX "classrooms_git_org_id_content_repo_key" ON "classrooms"("git_org_id", "content_repo");
