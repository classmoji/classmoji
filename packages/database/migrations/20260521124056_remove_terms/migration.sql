-- Add new columns nullable for backfill
ALTER TABLE "classrooms" ADD COLUMN "content_namespace" TEXT;
ALTER TABLE "classrooms" ADD COLUMN "pin_order" INTEGER;

-- Backfill content_namespace
-- Legacy term/year -> "25f" style
UPDATE "classrooms"
SET "content_namespace" = (
  SUBSTRING(CAST("year" AS TEXT) FROM LENGTH(CAST("year" AS TEXT)) - 1)
  ||
  -- Term enum values are stored uppercase in Postgres
  CASE "term"
    WHEN 'WINTER' THEN 'w'
    WHEN 'SPRING' THEN 's'
    WHEN 'SUMMER' THEN 'u'
    WHEN 'FALL'   THEN 'f'
    ELSE LOWER(LEFT("term"::text, 1))
  END
)
WHERE "term" IS NOT NULL AND "year" IS NOT NULL;

-- Rows with no term -> use slug
UPDATE "classrooms"
SET "content_namespace" = "slug"
WHERE "content_namespace" IS NULL;

-- Make NOT NULL
ALTER TABLE "classrooms" ALTER COLUMN "content_namespace" SET NOT NULL;

-- Append term/year to name where missing, to preserve human-readable disambiguation
UPDATE "classrooms"
SET "name" = "name" || ' ' || INITCAP(LOWER("term"::text)) || ' ' || "year"
WHERE "term" IS NOT NULL
  AND "year" IS NOT NULL
  AND "name" !~* ('\m' || INITCAP(LOWER("term"::text)) || '\M')
  AND "name" !~* ('\m' || "year"::text || '\M');

-- Pre-check: any duplicate (git_org_id, slug) pairs? Should be impossible because slug is currently globally unique.
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT git_org_id, slug FROM classrooms GROUP BY git_org_id, slug HAVING COUNT(*) > 1
  ) x;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply unique(git_org_id, slug): % duplicates exist', dup_count;
  END IF;
END $$;

-- Drop the global unique index on slug, add composite unique on (git_org_id, slug)
DROP INDEX IF EXISTS "classrooms_slug_key";
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_git_org_id_slug_key" UNIQUE ("git_org_id", "slug");
-- Name uniqueness is intentionally NOT enforced; landing screen disambiguates duplicates visually.
