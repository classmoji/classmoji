-- `forms` joins RESERVED_PAGE_SLUGS: evict the pages already holding it.
--
-- Why now: a class site serves the short form link at
-- `{subdomain}.classmoji.io/forms/{formSlug}`, so `forms` is now a platform-
-- owned first segment inside a course site the same way `schedule` and `app`
-- are. Static segments outrank `:pageSlug` in the router, so a page slugged
-- `forms` is not a security problem — it is simply a page nobody can open, and
-- the instructor's first hint would be a broken link.
--
-- Modelled on 20260821003300_page_slug_backfill_and_unique, which added the
-- registry's first five entries and says in its own header that a later
-- addition "needs a new migration modelled on this one". This is that
-- migration, narrowed to the one thing it has to do: there are no backfills or
-- duplicates left to repair (the unique index has been enforcing that since
-- August), so the only case here is an incumbent on a newly reserved slug.
--
-- ⚠ The reserved list below is a copy of RESERVED_PAGE_SLUGS in
-- packages/utils/src/subdomains.ts, which is the single authority (SQL cannot
-- import it). `subdomains.test.ts` asserts the two agree.
-- ---------------------------------------------------------------------------

-- The same audit table the August migration wrote to, and for the same reason:
-- these renames change PUBLIC URLs, and the old value is overwritten in place,
-- so without a row nothing in the system remembers what a link used to be.
-- IF NOT EXISTS because that migration created it and nothing has dropped it.
CREATE TABLE IF NOT EXISTS "_page_slug_repairs" (
  page_id     TEXT NOT NULL,
  classroom_id TEXT NOT NULL,
  old_slug    TEXT,
  new_slug    TEXT,
  reason      TEXT NOT NULL,  -- 'backfill' | 'duplicate' | 'reserved'
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  -- Mirrors RESERVED_PAGE_SLUGS in packages/utils/src/subdomains.ts, same order.
  reserved CONSTANT TEXT[] := ARRAY['app', 'classmoji', 'sign-in', 'schedule', 'forms', 'robots.txt'];
  -- Mirrors PAGE_SLUG_MAX_SUFFIX in packages/services/src/classmoji/page.service.ts.
  max_suffix CONSTANT INT := 50;
  loser  RECORD;
  cands  TEXT[];
  cand   TEXT;
  chosen TEXT;
  n_evicted INT;
BEGIN
  SELECT COUNT(*) INTO n_evicted FROM "pages" WHERE "slug" = ANY (reserved);
  RAISE NOTICE 'reserving page slug "forms": % page(s) on a reserved slug', n_evicted;

  -- Driven off `reserved`, NOT off the literal 'forms', for two reasons. It is
  -- what makes the array the eviction set rather than decoration — the
  -- cross-file test in packages/utils asserts exactly that, and a contributor
  -- copying this file for a seventh reserved slug would otherwise add it to the
  -- array, watch the test go green, and evict nothing. And it costs nothing:
  -- the other five were evicted in August and page.service has refused them at
  -- create ever since, so they match no rows here and a re-apply matches none
  -- either.
  --
  -- Every row holding one is evicted, including the oldest: a reserved slug has
  -- no winner. Ordered so a dry run, staging and production resolve two pages
  -- in one classroom the same way.
  FOR loser IN
    SELECT "id", "classroom_id", "slug" AS old_slug
    FROM "pages"
    WHERE "slug" = ANY (reserved)
    ORDER BY "classroom_id", "created_at", "id"
  LOOP
    cands := ARRAY(SELECT loser.old_slug || '-' || n FROM generate_series(2, max_suffix) AS n);
    chosen := NULL;

    FOREACH cand IN ARRAY cands
    LOOP
      CONTINUE WHEN cand = ANY (reserved);
      -- Reads LIVE state, so an already-present `forms-2` pushes this row onto
      -- `forms-3` rather than onto a 23505.
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
      -- Insurance tail: `id` is a uuid, so this cannot collide. Only reachable
      -- if one classroom already holds 49 variants of `forms`.
      chosen := loser.old_slug || '-' || loser.id;
    END IF;

    INSERT INTO "_page_slug_repairs" (page_id, classroom_id, old_slug, new_slug, reason)
    VALUES (loser.id, loser.classroom_id, loser.old_slug, chosen, 'reserved');

    UPDATE "pages" SET "slug" = chosen WHERE "id" = loser.id;
  END LOOP;
END $$;
