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
-- Repair existing duplicate slugs.
--
-- Winner keeps the slug; every loser is renamed. Winner precedence: most
-- memberships, then most git_repos, then oldest created_at, then lowest id.
-- ROW_NUMBER (not a self-referencing EXISTS predicate) is required here: with a
-- 4-key rule an EXISTS comparison renames both rows or neither whenever the
-- leading keys tie.
--
-- Each loser WALKS A CANDIDATE LIST and takes the first slug no other row
-- holds, mirroring `classroomSlugCandidates()` in
-- packages/services/src/classmoji/classroomSlug.ts: org-qualified first (the
-- bare slug is the winner's), then id-suffixed as the always-free fallback. A
-- row renamed here and a row created by the app are therefore named by the same
-- rule.
--
-- Choosing the candidate INSIDE the walk — rather than renaming first and
-- disambiguating afterwards — is what makes this safe. The composite unique
-- (git_org_id, slug) is live throughout, so a blind `{slug}-{org}` rename
-- raises 23505 the moment a loser's target is already held by a classroom in
-- its OWN org ("Acme" owning both `cs500` and `cs500-acme`), and the repair
-- would abort before any after-the-fact fixup could run.
--
-- The invariant: immediately before each UPDATE, no other row holds `chosen`,
-- so neither the retained composite nor the incoming global unique can fire.
-- The freeness check reads LIVE state, so it sees every rename already granted
-- in this loop. It is deliberately conservative in the other direction — a slug
-- still held by a loser that has not been processed yet reads as taken even
-- though it will be vacated — which can only push a loser onto a later
-- candidate, never onto a colliding one.
--
-- Winners and never-duplicated incumbents are not in the loop's row set at all,
-- so they are never touched.
--
-- git_organizations.login preserves GitHub's case (~100 of 159 prod orgs have
-- uppercase logins), so it is lowercased and sanitized to [a-z0-9-] with runs
-- collapsed and edges trimmed — matching all three slugify() implementations in
-- the app. Anything else would mint a slug no code path can reproduce and a URL
-- that only resolves with exact case.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  loser  RECORD;
  cand   TEXT;
  chosen TEXT;
BEGIN
  FOR loser IN
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
    -- Ordered so the run is reproducible: when two losers from different groups
    -- want the same candidate, processing order decides who gets it, and that
    -- must be the same on a dry run, on staging, and in production.
    SELECT
      r."id"         AS id,
      r."slug"       AS old_slug,
      r."git_org_id" AS git_org_id,
      r.org_suffix   AS org_suffix
    FROM ranked r
    WHERE r.rn > 1
    ORDER BY r."slug", r.rn
  LOOP
    chosen := NULL;

    FOREACH cand IN ARRAY ARRAY[
      -- 1. `{slug}-{org login}` — the app's first collision candidate.
      loser.old_slug || '-' || loser.org_suffix,
      -- 2. id-suffixed. `id` is a uuid, so the first 8 hex chars are random;
      --    this is free in every realistic shape.
      loser.old_slug || '-' || loser.org_suffix || '-' || substr(loser.id::text, 1, 8),
      -- 3. full id. Insurance only: unreachable unless some row already holds
      --    candidate 2, which requires an 8-hex-char birthday collision inside
      --    one group.
      loser.old_slug || '-' || loser.org_suffix || '-' || loser.id::text
    ]
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM "classrooms" other
        WHERE other."id" <> loser.id
          AND (
            -- incoming global unique
            other."slug" = cand
            -- retained (git_org_id, slug) composite; spelled out deliberately
            -- even though equal (git_org_id, slug) implies equal slug, so that
            -- narrowing the branch above can never silently drop the in-org
            -- guarantee. This is the constraint the un-walked rename hit.
            OR (other."git_org_id" = loser.git_org_id AND other."slug" = cand)
          )
      ) THEN
        chosen := cand;
        EXIT;
      END IF;
    END LOOP;

    IF chosen IS NULL THEN
      RAISE EXCEPTION
        'Cannot repair duplicate classroom slug %: every candidate is taken (classroom id %, org suffix %)',
        loser.old_slug, loser.id, loser.org_suffix;
    END IF;

    UPDATE "classrooms" SET "slug" = chosen WHERE "id" = loser.id;
  END LOOP;
END $$;

-- Guard: fail loudly with the offending slugs rather than on a bare index
-- error. Unreachable by construction now that the repair never writes a slug
-- another row holds — kept because it costs one query and is the only thing
-- standing between a future edit to the walk above and an opaque 23505 in a
-- release command.
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
