-- Make `pages.slug` a real per-classroom address: backfill the rows that never
-- got one, evict the rows squatting on reserved site paths, break ties, then
-- lock it in with UNIQUE (classroom_id, slug).
--
-- Why now: the public course site addresses a page as
-- `{subdomain}.classmoji.io/{slug}`. Today the column is nullable, is written
-- once at create with no uniqueness check, and — because
-- `titleToIdentifier('')` returns '' rather than null — some rows carry an
-- EMPTY STRING. Under a unique index '' is an ordinary value, so two such rows
-- collide; only NULL is exempt. Both shapes have to be resolved before the
-- index can exist.
--
-- NULL is deliberately KEPT legal. Postgres's default NULLS DISTINCT lets any
-- number of pages whose title reduces to nothing (an emoji, punctuation) sit at
-- slug = NULL; they simply have no site URL and are reachable by id. Minting a
-- synthetic slug for them would be inventing a public address nobody asked for.
--
-- The whole repair is ONE PL/pgSQL walk rather than three passes because the
-- three problems share one resource — the set of slugs free in a classroom. A
-- backfill pass that ran before the dedupe pass would hand out values the
-- dedupe pass then had to take back.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Preflight survey. Not a guard — it cannot fail — but a release command that
-- rewrites user-visible URLs should say how many and of which kind before it
-- does it, so the numbers in the deploy log can be compared against a dry run.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_backfill INT;
  n_dupes    INT;
  n_reserved INT;
BEGIN
  SELECT COUNT(*) INTO n_backfill FROM "pages" WHERE "slug" IS NULL OR "slug" = '';
  SELECT COALESCE(SUM(c - 1), 0) INTO n_dupes FROM (
    SELECT COUNT(*) AS c FROM "pages"
    WHERE "slug" IS NOT NULL AND "slug" <> ''
    GROUP BY "classroom_id", "slug" HAVING COUNT(*) > 1
  ) x;
  SELECT COUNT(*) INTO n_reserved FROM "pages"
    WHERE "slug" IN ('app', 'classmoji', 'sign-in', 'schedule', 'robots.txt');
  RAISE NOTICE 'page slug repair: % to backfill, % duplicate losers, % on reserved paths',
    n_backfill, n_dupes, n_reserved;
END $$;

-- ---------------------------------------------------------------------------
-- The audit trail.
--
-- Every NOTICE in this file is written to nowhere. `prisma migrate deploy`
-- does not surface PL/pgSQL notices, so on the deploy that matters — the
-- production one — the survey above and the per-row detail below are simply
-- discarded. They are kept because they are free and because they do show up
-- under psql during a dry run, but they are NOT the record.
--
-- A record is needed because these renames change PUBLIC URLs. A page that
-- lived at `{subdomain}/syllabus` moves to `{subdomain}/syllabus-2`, or a page
-- squatting on `{subdomain}/app` is evicted outright, and the first anyone
-- hears of it is an instructor asking why their link broke. Without this table
-- there is no way to answer: the old value is gone, overwritten in place, and
-- nothing else in the system remembers it. With it, the answer is one query.
--
-- Underscore-prefixed and deliberately ABSENT from schema.prisma, the same
-- shape as `_prisma_migrations`: an operational side-table, not part of the
-- app's data model, never in the generated client. Because schema.prisma is
-- what `migrate dev` diffs against, the next generated migration will propose
-- dropping it — that is the intended end of its life, not a problem to work
-- around. Drop it once the deploy has been read.
--
-- IF NOT EXISTS so a re-apply (this migration removed from _prisma_migrations
-- and replayed) appends to the existing log rather than failing on the table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "_page_slug_repairs" (
  page_id     TEXT NOT NULL,
  classroom_id TEXT NOT NULL,
  old_slug    TEXT,
  new_slug    TEXT,
  reason      TEXT NOT NULL,  -- 'backfill' | 'duplicate' | 'reserved'
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The repair.
--
-- A row is REASSIGNED when it holds nothing (slug NULL or ''), when it holds a
-- slug some older sibling also holds, or when it holds one of the reserved
-- first segments of the site URL namespace. Every other row is untouched: it
-- keeps the exact slug that is already in links, bookmarks and content.
--
-- Winner precedence inside a duplicate group is `created_at ASC, id ASC` — the
-- oldest page keeps the bare slug, because it is the one whose URL has been in
-- circulation longest. ROW_NUMBER is used rather than a self-referencing EXISTS
-- for the same reason as the classroom slug migration: an EXISTS comparison
-- renames both rows or neither when the leading keys tie.
--
-- Rows needing a backfill are NEVER winners. They currently address nothing, so
-- an incumbent's live URL always outranks them: a NULL-slug "Syllabus" filed
-- behind an existing `syllabus` becomes `syllabus-2`, never the other way
-- round.
--
-- A reserved slug has NO winner — every row holding it is evicted, including
-- the oldest. `{subdomain}/app` has to be the app, not somebody's page.
--
-- Each loser then WALKS A CANDIDATE LIST and takes the first slug no sibling
-- holds. This is what makes pre-existing suffixed values safe: with `foo`,
-- another `foo`, and an already-present `foo-2` in the same classroom, a naive
-- ROW_NUMBER + '-' || rn would hand the loser `foo-2` and hit 23505. The walk
-- reads LIVE state, sees the incumbent `foo-2`, and moves on to `foo-3`. It is
-- conservative in the other direction too — a slug still held by a loser that
-- has not been processed yet reads as taken even though it will be vacated —
-- which can only push a row onto a LATER candidate, never onto a colliding one.
--
-- Reserved values are skipped as candidates as well as evicted as incumbents,
-- so a NULL-slug page titled "Schedule" starts at `schedule-2` and never
-- briefly claims `schedule`.
--
-- ⚠ The reserved list below is a copy of RESERVED_PAGE_SLUGS in
-- packages/utils/src/subdomains.ts, which is the single authority (SQL cannot
-- import it). Adding a reserved path there does NOT retroactively evict pages
-- that already hold it — that needs a new migration modelled on this one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- Mirrors RESERVED_PAGE_SLUGS in packages/utils/src/subdomains.ts, same order.
  reserved CONSTANT TEXT[] := ARRAY['app', 'classmoji', 'sign-in', 'schedule', 'robots.txt'];
  -- Mirrors PAGE_SLUG_MAX_SUFFIX in packages/services/src/classmoji/page.service.ts,
  -- so a row renamed here and a page created by the app are named by the same
  -- rule. The id-suffixed tail below has no counterpart there on purpose: the
  -- app can surface "pick another title" to a human, a release command cannot.
  max_suffix CONSTANT INT := 50;
  loser  RECORD;
  cands  TEXT[];
  cand   TEXT;
  chosen TEXT;
BEGIN
  FOR loser IN
    WITH derived AS (
      SELECT
        p."id",
        p."classroom_id",
        p."slug",
        p."created_at",
        (p."slug" IS NULL OR p."slug" = '') AS needs_backfill,
        -- SQL port of titleToIdentifier() in packages/utils/src/index.ts, step
        -- for step: lower → drop anything outside [a-z0-9 -] → space runs to a
        -- hyphen → hyphen runs to one hyphen → trim the edges. Note it PRESERVES
        -- hyphens already in the title, which is what makes it different from
        -- slugify() in classroomSlug.ts; do not "unify" the two.
        --
        -- NULLIF is the one deliberate divergence: titleToIdentifier returns ''
        -- for a title with no usable characters, and '' is exactly the value
        -- this migration exists to eliminate. Empty means NULL here.
        NULLIF(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(p."title"), '[^a-z0-9 -]', '', 'g'),
                ' +', '-', 'g'
              ),
              '-+', '-', 'g'
            ),
            '^-|-$', '', 'g'
          ),
          ''
        ) AS derived_slug
      FROM "pages" p
    ),
    ranked AS (
      SELECT
        d.*,
        -- Ranked only among rows that actually hold this slug; backfill rows
        -- are excluded from the partition so they cannot displace an incumbent.
        CASE
          WHEN d.needs_backfill THEN NULL
          ELSE ROW_NUMBER() OVER (
            PARTITION BY d."classroom_id", d."slug"
            ORDER BY d."created_at" ASC, d."id" ASC
          )
        END AS rn
      FROM derived d
    )
    SELECT
      r."id"           AS id,
      r."classroom_id" AS classroom_id,
      r.needs_backfill AS needs_backfill,
      -- Carried purely for the audit table: the value about to be overwritten.
      r."slug"         AS old_slug,
      -- Why this row is being rewritten. Precedence mirrors the WHERE below,
      -- with reserved ahead of duplicate because it is the more specific
      -- answer when a row is both (two pages can share the slug `app`). A
      -- backfill can never also be reserved — no reserved value is '' or NULL.
      CASE
        WHEN r.needs_backfill        THEN 'backfill'
        WHEN r."slug" = ANY (reserved) THEN 'reserved'
        ELSE 'duplicate'
      END AS reason,
      -- What to build candidates from: the derived slug for a backfill, the
      -- slug it already holds for an evicted incumbent.
      CASE WHEN r.needs_backfill THEN r.derived_slug ELSE r."slug" END AS base
    FROM ranked r
    WHERE r.needs_backfill
       OR r.rn > 1
       OR r."slug" = ANY (reserved)
    -- Deterministic: two rows wanting the same base must be resolved in the
    -- same order on a dry run, on staging, and in production.
    ORDER BY r."classroom_id", base, r.needs_backfill, r."created_at", r."id"
  LOOP
    -- Title with no usable characters. NULL, never '' — see the header.
    IF loser.base IS NULL THEN
      -- LOGGING RULE: a row is logged if and only if its stored value actually
      -- changes. Here that means '' → NULL only. A row already at NULL matches
      -- `needs_backfill` on EVERY apply — it has no derivable slug and never
      -- will — so logging it would append the same phantom rows each time the
      -- migration ran, and would break the one useful property of this table:
      -- a replay over already-repaired data writes nothing. `NULL = ''` is
      -- NULL, which IF treats as false, so the NULL case falls through
      -- silently, exactly as intended.
      IF loser.old_slug = '' THEN
        INSERT INTO "_page_slug_repairs" (page_id, classroom_id, old_slug, new_slug, reason)
        VALUES (loser.id, loser.classroom_id, loser.old_slug, NULL, loser.reason);
      END IF;
      UPDATE "pages" SET "slug" = NULL WHERE "id" = loser.id;
      CONTINUE;
    END IF;

    cands := ARRAY[loser.base]
      || ARRAY(SELECT loser.base || '-' || n FROM generate_series(2, max_suffix) AS n)
      -- Insurance tail. `id` is a uuid, so the first 8 hex chars are random and
      -- free in every realistic shape; the full id cannot collide at all. Only
      -- reachable if one classroom holds 50 variants of one base.
      || ARRAY[
        loser.base || '-' || substr(loser.id, 1, 8),
        loser.base || '-' || loser.id
      ];

    chosen := NULL;

    FOREACH cand IN ARRAY cands
    LOOP
      CONTINUE WHEN cand = ANY (reserved);
      IF NOT EXISTS (
        SELECT 1 FROM "pages" other
        WHERE other."id" <> loser.id
          AND other."classroom_id" = loser.classroom_id
          AND other."slug" = cand
      ) THEN
        chosen := cand;
        EXIT;
      END IF;
    END LOOP;

    IF chosen IS NULL THEN
      RAISE EXCEPTION
        'Cannot assign a page slug from base %: every candidate is taken (page id %, classroom %)',
        loser.base, loser.id, loser.classroom_id;
    END IF;

    -- Logged unconditionally: unlike the branch above, this one ALWAYS changes
    -- the stored value. `base` is never itself the winning candidate here — a
    -- duplicate loser's base is held by the winner, a reserved incumbent's base
    -- is skipped by the walk, and a backfill's base replaces NULL or ''. So
    -- there is no no-op to filter out, and none of these rows can re-enter the
    -- walk on a later apply.
    INSERT INTO "_page_slug_repairs" (page_id, classroom_id, old_slug, new_slug, reason)
    VALUES (loser.id, loser.classroom_id, loser.old_slug, chosen, loser.reason);

    UPDATE "pages" SET "slug" = chosen WHERE "id" = loser.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Postflight guards. Unreachable by construction now that the walk never writes
-- a slug a sibling holds and never writes ''. Kept because together they cost
-- two queries and are the only thing standing between a future edit to the walk
-- above and an opaque 23505 inside a release command — with the offending rows
-- named, instead of "duplicate key value violates unique constraint".
-- ---------------------------------------------------------------------------
DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg(format('%s/%s (x%s)', "classroom_id", "slug", c), ', ') INTO offenders FROM (
    SELECT "classroom_id", "slug", COUNT(*) AS c
    FROM "pages"
    WHERE "slug" IS NOT NULL
    GROUP BY "classroom_id", "slug"
    HAVING COUNT(*) > 1
  ) x;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot apply unique(classroom_id, slug): duplicates remain after repair: %', offenders;
  END IF;
END $$;

DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO offenders FROM "pages" WHERE "slug" = '';
  IF offenders IS NOT NULL THEN
    -- '' would pass the unique index only until a second one appeared, so this
    -- has to fail here rather than ship a latent collision.
    RAISE EXCEPTION 'Empty-string page slugs remain after repair (page ids): %', offenders;
  END IF;
END $$;

-- CreateIndex
-- Non-concurrent by necessity: Prisma wraps each migration file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one.
--
-- The name is not decorative — it is the name Prisma derives for
-- @@unique([classroom_id, slug]) on the Page model ({table}_{cols}_key, as on
-- `slides_classroom_id_slug_key`). A different name reads as schema drift and
-- the next `migrate dev` would try to drop and recreate it.
CREATE UNIQUE INDEX "pages_classroom_id_slug_key" ON "pages"("classroom_id", "slug");
