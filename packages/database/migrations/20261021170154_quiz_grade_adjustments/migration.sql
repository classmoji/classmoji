-- Quiz grade adjustments and quiz regrade/resubmit requests.
--
-- quiz_attempts: a staff adjustment is an emoji on the classroom's scale
-- (`adjusted_emoji`, a `score-N` badge on the numeric scale), read through the
-- classroom's emoji_mappings at compute time like a repo grade. The AI's
-- evaluation columns are never edited. `instructor_comment` can be set without
-- a score change.
--
-- regrade_requests: a request targets a repo submission OR a quiz attempt,
-- exactly one (CHECK below). One open (IN_REVIEW) request per quiz attempt
-- (partial unique index below): a second create returns the open one.
--
-- (The `_page_slug_repairs` log table from 20260821003300 is not in the Prisma
-- schema on purpose; the DROP that `migrate dev` generated for it is removed.)

-- AlterTable
ALTER TABLE "quiz_attempts" ADD COLUMN     "adjusted_at" TIMESTAMP(3),
ADD COLUMN     "adjusted_by_id" TEXT,
ADD COLUMN     "adjusted_emoji" TEXT,
ADD COLUMN     "instructor_comment" TEXT;

-- AlterTable
ALTER TABLE "regrade_requests" ADD COLUMN     "quiz_attempt_id" TEXT,
ALTER COLUMN "git_repo_assignment_id" DROP NOT NULL;

-- Exactly one target per request
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_one_target"
  CHECK ((("git_repo_assignment_id" IS NOT NULL)::int + ("quiz_attempt_id" IS NOT NULL)::int) = 1);

-- CreateIndex
CREATE INDEX "regrade_requests_quiz_attempt_id_idx" ON "regrade_requests"("quiz_attempt_id");

-- One open request per quiz attempt
CREATE UNIQUE INDEX "regrade_requests_open_quiz_attempt" ON "regrade_requests"("quiz_attempt_id") WHERE "status" = 'IN_REVIEW' AND "quiz_attempt_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_quiz_attempt_id_fkey" FOREIGN KEY ("quiz_attempt_id") REFERENCES "quiz_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_adjusted_by_id_fkey" FOREIGN KEY ("adjusted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
