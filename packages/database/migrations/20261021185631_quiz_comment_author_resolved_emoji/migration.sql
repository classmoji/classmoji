-- Quiz attempt comment authorship, and the grade a quiz regrade resolution set.
--
-- quiz_attempts: `comment_by_id` / `comment_at` record who last wrote the
-- instructor comment, apart from `adjusted_by_id` / `adjusted_at`, which now
-- record only the score adjustment (cleared on revert; the comment and its
-- author stay).
--
-- regrade_requests: `resolved_emoji` snapshots a quiz request's resolution:
-- the emoji set (APPROVED) or the effective emoji kept (DENIED). Rows resolved
-- before this column read the attempt's current grade instead.
--
-- (The `_page_slug_repairs` log table from 20260821003300 is not in the Prisma
-- schema on purpose; the DROP that `migrate dev` generated for it is removed.)

-- AlterTable
ALTER TABLE "quiz_attempts" ADD COLUMN     "comment_at" TIMESTAMP(3),
ADD COLUMN     "comment_by_id" TEXT;

-- AlterTable
ALTER TABLE "regrade_requests" ADD COLUMN     "resolved_emoji" TEXT;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_comment_by_id_fkey" FOREIGN KEY ("comment_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: an existing comment was last written by the last adjuster.
UPDATE "quiz_attempts"
SET "comment_by_id" = "adjusted_by_id", "comment_at" = "adjusted_at"
WHERE "instructor_comment" IS NOT NULL;

-- A comment-only edit no longer counts as a score adjustment.
UPDATE "quiz_attempts"
SET "adjusted_by_id" = NULL, "adjusted_at" = NULL
WHERE "adjusted_emoji" IS NULL;
