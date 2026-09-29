-- Media, phase 3: agent upload staging, and FILE slides stored in media.
--
-- ── STAGING ─────────────────────────────────────────────────────────────────
-- An agent upload (MCP `file_upload_start`, `file_import_url`) lands under the
-- media bucket's `stage/` prefix first and is then PLACED: committed to the
-- content repo, or copied into media. Its row is a `media_objects` row in the
-- new STAGING status, so it holds a quota reservation exactly like UPLOADING
-- (the same 24 h window) with no second ledger to keep in step.
--
-- The new value is not used by any other statement in this migration: a value
-- added with ALTER TYPE ... ADD VALUE cannot be referenced in the transaction
-- that added it.
--
-- The five columns are NULL on every normal upload:
--   destination        'repo' | 'media' — where the staged bytes are going,
--                       decided by the storage router when the stage opens;
--   stage_target_type  'page' | 'slide' — what the file is being added to;
--   stage_target_id    that page's or slide's id;
--   placed_ref         the reference the placement produced (a repo path or
--                       `media://{id}`);
--   placement_error    why placement failed, when it did.
--
-- ── slides.media_id ─────────────────────────────────────────────────────────
-- A FILE slide on a Pro classroom whose document is over the repository's cap
-- lives in media; this names the object. `source_path` cannot carry it — it is
-- a repo path handed straight to git. ON DELETE SET NULL: deleting the media
-- object leaves the slide with nothing to download rather than deleting it.

-- AlterEnum
ALTER TYPE "MediaStatus" ADD VALUE 'STAGING';

-- AlterTable
ALTER TABLE "media_objects" ADD COLUMN     "destination" TEXT,
ADD COLUMN     "placed_ref" TEXT,
ADD COLUMN     "placement_error" TEXT,
ADD COLUMN     "stage_target_id" TEXT,
ADD COLUMN     "stage_target_type" TEXT;

-- AlterTable
ALTER TABLE "slides" ADD COLUMN     "media_id" TEXT;

-- CreateIndex
CREATE INDEX "slides_media_id_idx" ON "slides"("media_id");

-- AddForeignKey
ALTER TABLE "slides" ADD CONSTRAINT "slides_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
