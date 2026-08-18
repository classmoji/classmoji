-- Restore GLOBAL uniqueness on classrooms.slug.
--
-- The slug is the sole key in every app URL (/admin/:class, /student/:class,
-- the ICS calendar feed, the autograde callback) and in two HMAC credentials;
-- none of them carry an org segment. `classrooms_slug_key` existed from the
-- init migration until 20260521124056_remove_terms dropped it in favour of a
-- per-org composite, which let two orgs claim the same URL and read each
-- other's classroom. This migration is the reverse of that drop.
--
-- The composite unique (git_org_id, slug) is deliberately KEPT: it is now
-- logically redundant, but it is the compound key live upserts select on.

-- ---------------------------------------------------------------------------
-- Pass 1: repair existing duplicate slugs.
--
-- Winner keeps the slug; every loser is renamed to {slug}-{sanitized org login}.
-- Winner precedence: most memberships, then most git_repos, then oldest
-- created_at, then lowest id. ROW_NUMBER (not a self-referencing EXISTS
-- predicate) is required here: with a 4-key rule an EXISTS comparison renames
-- both rows or neither whenever the leading keys tie.
--
-- git_organizations.login preserves GitHub's case (~100 of 159 prod orgs have
-- uppercase logins), so it is lowercased and sanitized to [a-z0-9-] with runs
-- collapsed and edges trimmed — matching all three slugify() implementations in
-- the app. Anything else would mint a slug no code path can reproduce and a URL
-- that only resolves with exact case.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "_classroom_slug_repair";

CREATE TEMP TABLE "_classroom_slug_repair" AS
WITH dupes AS (
  SELECT "slug" FROM "classrooms" GROUP BY "slug" HAVING COUNT(*) > 1
),
scored AS (
  SELECT
    c."id",
    c."slug",
    c."git_org_id",
    c."created_at",
    (SELECT COUNT(*) FROM "classroom_memberships" m WHERE m."classroom_id" = c."id") AS member_count,
    (SELECT COUNT(*) FROM "git_repos" g WHERE g."classroom_id" = c."id") AS repo_count,
    -- Empty fallback covers logins with no alphanumerics (e.g. the mock orgs
    -- backing example classrooms).
    COALESCE(
      NULLIF(
        regexp_replace(
          regexp_replace(lower(o."login"), '[^a-z0-9]+', '-', 'g'),
          '^-+|-+$', '', 'g'
        ),
        ''
      ),
      substr(c."id"::text, 1, 8)
    ) AS org_suffix
  FROM "classrooms" c
  JOIN "git_organizations" o ON o."id" = c."git_org_id"
  WHERE c."slug" IN (SELECT "slug" FROM dupes)
),
ranked AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      PARTITION BY s."slug"
      ORDER BY s.member_count DESC, s.repo_count DESC, s."created_at" ASC, s."id" ASC
    ) AS rn
  FROM scored s
)
SELECT "id", "slug" AS old_slug, "slug" || '-' || org_suffix AS new_slug
FROM ranked
WHERE rn > 1;

UPDATE "classrooms" c
SET "slug" = r.new_slug
FROM "_classroom_slug_repair" r
WHERE c."id" = r."id";

-- ---------------------------------------------------------------------------
-- Pass 2 (defensive): a renamed slug can still collide — with an unrelated
-- classroom that already used that exact string, or with another loser whose
-- org login sanitizes to the same suffix. Only rows renamed in pass 1 are
-- eligible, so incumbents are never touched; because BOTH colliding losers are
-- in the repair table, both get a distinct id suffix rather than one being left
-- to fight the other. Checks the incoming global unique AND the retained
-- (git_org_id, slug) composite, since a rename can collide inside its own org.
-- ---------------------------------------------------------------------------
UPDATE "classrooms" c
SET "slug" = c."slug" || '-' || substr(c."id"::text, 1, 8)
WHERE c."id" IN (SELECT "id" FROM "_classroom_slug_repair")
  AND EXISTS (
    SELECT 1 FROM "classrooms" other
    WHERE other."id" <> c."id"
      AND (
        -- incoming global unique
        other."slug" = c."slug"
        -- retained (git_org_id, slug) composite; spelled out deliberately even
        -- though equal (git_org_id, slug) implies equal slug, so that narrowing
        -- the branch above can never silently drop the in-org guarantee.
        OR (other."git_org_id" = c."git_org_id" AND other."slug" = c."slug")
      )
  );

DROP TABLE "_classroom_slug_repair";

-- Guard: fail loudly with the offending slugs rather than on a bare index error.
DO $$
DECLARE dup_slugs TEXT;
BEGIN
  SELECT string_agg("slug", ', ') INTO dup_slugs FROM (
    SELECT "slug" FROM "classrooms" GROUP BY "slug" HAVING COUNT(*) > 1
  ) x;
  IF dup_slugs IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot apply unique(slug): duplicates remain after repair: %', dup_slugs;
  END IF;
END $$;

-- CreateIndex
-- Non-concurrent by necessity: Prisma wraps each migration file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. The table is
-- ~900 rows in production, so the lock window is negligible.
CREATE UNIQUE INDEX "classrooms_slug_key" ON "classrooms"("slug");

-- ---------------------------------------------------------------------------
-- GitHub Classroom course id.
--
-- Nullable and NOT backfilled: classrooms created directly in Classmoji never
-- have one, and already-imported rows can't be recovered (the id is fetched and
-- then dropped today). Postgres permits many NULLs under a unique index, which
-- is exactly the semantics wanted.
--
-- Unique because one GitHub Classroom course maps to at most one Classmoji
-- classroom. That makes it the stable idempotency key for re-import, which the
-- slug can no longer be now that a colliding slug may carry an org suffix.
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "classrooms" ADD COLUMN "github_classroom_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_github_classroom_id_key" ON "classrooms"("github_classroom_id");
