-- Project gallery: a form can feed its GitHub org's public project gallery,
-- and each response carries a moderation state.
--
-- `forms.gallery_org_id` is nullable (null = not a gallery form) and SET NULL on
-- org delete, the same rule as form_responses.added_by. It is always the form's
-- own classroom's org; form.service.setGalleryOrg is the only writer.
--
-- `form_responses.gallery_status` is NOT NULL DEFAULT 'PENDING': existing rows
-- backfill to PENDING, which is correct — nothing is public until approved.
--
-- `projects` joins RESERVED_PAGE_SLUGS in the same migration, because the class
-- site now answers `/projects` itself. The eviction block is a copy of
-- 20260902180000_reserve_forms_page_slug with `projects` appended to the array.
--
-- ⚠ The reserved list below is a copy of RESERVED_PAGE_SLUGS in
-- packages/utils/src/subdomains.ts (SQL cannot import it). subdomains.test.ts
-- asserts the two agree. Prisma runs the whole file in one transaction.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "GalleryStatus" AS ENUM ('PENDING', 'APPROVED', 'HIDDEN');

-- AlterTable
ALTER TABLE "forms" ADD COLUMN "gallery_org_id" TEXT;

-- AlterTable
ALTER TABLE "form_responses" ADD COLUMN "gallery_status" "GalleryStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "forms_gallery_org_id_idx" ON "forms"("gallery_org_id");

-- CreateIndex
CREATE INDEX "form_responses_form_id_gallery_status_idx" ON "form_responses"("form_id", "gallery_status");

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_gallery_org_id_fkey" FOREIGN KEY ("gallery_org_id") REFERENCES "git_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Evict pages already holding a reserved slug ------------------------------

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
  reserved CONSTANT TEXT[] := ARRAY['app', 'classmoji', 'sign-in', 'schedule', 'forms', 'robots.txt', 'projects'];
  -- Mirrors PAGE_SLUG_MAX_SUFFIX in packages/services/src/classmoji/page.service.ts.
  max_suffix CONSTANT INT := 50;
  loser  RECORD;
  cands  TEXT[];
  cand   TEXT;
  chosen TEXT;
  n_evicted INT;
BEGIN
  SELECT COUNT(*) INTO n_evicted FROM "pages" WHERE "slug" = ANY (reserved);
  RAISE NOTICE 'reserving page slug "projects": % page(s) on a reserved slug', n_evicted;

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
      chosen := loser.old_slug || '-' || loser.id;
    END IF;

    INSERT INTO "_page_slug_repairs" (page_id, classroom_id, old_slug, new_slug, reason)
    VALUES (loser.id, loser.classroom_id, loser.old_slug, chosen, 'reserved');

    UPDATE "pages" SET "slug" = chosen WHERE "id" = loser.id;
  END LOOP;
END $$;
