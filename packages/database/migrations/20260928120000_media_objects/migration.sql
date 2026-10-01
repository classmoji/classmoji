-- Media objects: a classroom's large files, stored in R2 rather than in git.
--
-- A content repo takes at most 35 MB per file (`REPO_REST_MAX_BYTES`: GitHub
-- refuses the base64 request body above that), and lecture video is not that
-- size. Media takes a Pro classroom's files up to 2 GB each. This table is the
-- ledger for the files that go to R2 instead: what they are, who uploaded them,
-- how big they are, and whether they are finished.
--
-- ── NOT A CACHE ─────────────────────────────────────────────────────────────
-- `content_assets` is derivable from the repo and a lost row is repaired by a
-- re-sync. Nothing here is derivable from anything: this row and the R2 object
-- beside it ARE the file. That is why the row is created BEFORE the upload
-- starts (it is what the quota check reserves against) and why a delete has to
-- remove both halves.
--
-- ── NO KEY COLUMN ───────────────────────────────────────────────────────────
-- R2 keys are derived — `m/{classroom_id}/{id}/{variant}` where the variant is
-- `orig.{ext}`, `web-{hex12}.mp4` or `poster-{hex12}.jpg` (content-derived
-- names, so a re-encode never overwrites bytes an earlier URL pinned). The app
-- writes those keys and the
-- Worker reads them, so the two must agree byte for byte; that agreement lives
-- in ONE function (`mediaKey()` in @classmoji/content-signing) rather than in a
-- stored string a migration could drift from. `rendition_key` and `poster_key`
-- are the exception and are stored, because their PRESENCE is the state the
-- video job reports: a row with a rendition serves it, one without serves
-- the original.
--
-- ── QUOTA WITHOUT A COUNTER ─────────────────────────────────────────────────
-- Usage is a SUM over these rows, not a column: `size_bytes` for READY rows
-- that still have their original, `rendition_bytes` for the ones whose original
-- was dropped after processing, plus `size_bytes` for UPLOADING rows younger
-- than 24 hours (the reservation, so two concurrent uploads cannot both fit
-- under the same remaining space). A counter would need every path that fails
-- mid-upload to decrement it correctly; a sum cannot go wrong that way, and an
-- abandoned reservation falls out of it by age with nothing to run. R2 aborts
-- the abandoned multipart itself at 7 days.
--
-- `size_bytes` and `rendition_bytes` are BIGINT: the per-file ceiling is 2 GiB,
-- which is already past the 2^31 INTEGER limit, and the quota sums many of them.
--
-- ON DELETE CASCADE matches every other classroom-scoped table. The cascade
-- alone would orphan the R2 objects, so classroom deletion purges the
-- classroom's R2 prefix first (`purgeClassroomMedia`) and does not delete the
-- classroom when that purge fails.

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'READY', 'DELETED');

-- CreateEnum
-- Any file with an extension is accepted (decision §7.10: Pro routes video, and
-- anything over the repository's REST ceiling, to R2 — whatever it is). An
-- extension the store has a type for gets its kind; every other one is OTHER,
-- stored and served as application/octet-stream (a download).
CREATE TYPE "MediaKind" AS ENUM ('VIDEO', 'AUDIO', 'DOCUMENT', 'ARCHIVE', 'IMAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "MediaProcessing" AS ENUM ('NONE', 'PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "media_objects" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    -- The uploader's own name, verbatim. Display only, and the `dl` filename on
    -- a download URL — never a path, never part of a key.
    "filename" TEXT NOT NULL,
    -- Canonical lowercase extension of the original. Half of the `orig.{ext}`
    -- variant, so it is what a signed URL for the original is built from.
    "ext" TEXT NOT NULL,
    -- Server-assigned from `ext`, never taken from the client. Any extension is
    -- accepted: a known kind gets its real type, every other extension (kind
    -- OTHER) is application/octet-stream.
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "upload_id" TEXT,
    "uploaded_by" TEXT NOT NULL,
    -- The three upload-dialog options. Video only; every other kind keeps the
    -- defaults and nothing reads them.
    "optimise" BOOLEAN NOT NULL DEFAULT false,
    "keep_original" BOOLEAN NOT NULL DEFAULT true,
    "allow_download" BOOLEAN NOT NULL DEFAULT false,
    "processing" "MediaProcessing" NOT NULL DEFAULT 'NONE',
    "processing_error" TEXT,
    "rendition_key" TEXT,
    "rendition_bytes" BIGINT,
    "poster_key" TEXT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    -- When the original was dropped after a verified rendition. From then on the
    -- rendition's bytes are what this row costs against the quota.
    "original_deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Every read is classroom-scoped and status-filtered: the usage sum, the media
-- list, and the resolver's own lookup.
CREATE INDEX "media_objects_classroom_id_status_idx" ON "media_objects"("classroom_id", "status");

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
