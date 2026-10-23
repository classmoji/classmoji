-- A deck or page folder is exactly one segment under its top folder:
-- `slides/<seg>` / `pages/<seg>`, no leading or trailing slash, no nesting,
-- and a segment that does not start with `/` or `.` (so never `slides/` or
-- `slides/..`). Folder grants for frames and themes are computed from these
-- paths, and an empty or nested one would widen what a grant covers.
--
-- 1. Normalise the one harmless variant: stray leading/trailing slashes.
UPDATE "slides" SET "content_path" = btrim("content_path", '/')
WHERE "content_path" <> btrim("content_path", '/');

UPDATE "pages" SET "content_path" = btrim("content_path", '/')
WHERE "content_path" <> btrim("content_path", '/');

-- 2. The shape, for new and updated rows. NOT VALID so a stray legacy row the
-- trim cannot fix never blocks the deploy's release_command.
ALTER TABLE "slides" ADD CONSTRAINT "slides_content_path_shape"
  CHECK ("content_path" ~ '^slides/[^/.][^/]*$') NOT VALID;

ALTER TABLE "pages" ADD CONSTRAINT "pages_content_path_shape"
  CHECK ("content_path" ~ '^pages/[^/.][^/]*$') NOT VALID;

-- 3. Validate each one where no existing row is off-shape (prod had none on
-- 2026-10-21). A table that still has one keeps the NOT VALID constraint until
-- that row is fixed and the constraint is validated by hand.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "slides" WHERE NOT ("content_path" ~ '^slides/[^/.][^/]*$')
  ) THEN
    ALTER TABLE "slides" VALIDATE CONSTRAINT "slides_content_path_shape";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "pages" WHERE NOT ("content_path" ~ '^pages/[^/.][^/]*$')
  ) THEN
    ALTER TABLE "pages" VALIDATE CONSTRAINT "pages_content_path_shape";
  END IF;
END $$;
