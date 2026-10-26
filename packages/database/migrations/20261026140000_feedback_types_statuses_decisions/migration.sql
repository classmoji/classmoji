-- Feedback board: three post types with their own statuses, the Github bug
-- template fields, merged duplicates, public status notes and reply
-- notifications.
--
-- The two feedback enums are rebuilt with their final values rather than
-- grown with ADD VALUE: Postgres refuses a value added in the same
-- transaction, and rows are converted here as the columns change type.

-- Types: Integration requests are feature requests; Question is new.
CREATE TYPE "FeedbackCategory_new" AS ENUM ('FEATURE', 'BUG', 'QUESTION');
ALTER TABLE "feedback_posts" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "feedback_posts" ALTER COLUMN "category" TYPE "FeedbackCategory_new"
  USING (CASE WHEN "category"::text = 'INTEGRATION' THEN 'FEATURE' ELSE "category"::text END)::"FeedbackCategory_new";
ALTER TYPE "FeedbackCategory" RENAME TO "FeedbackCategory_old";
ALTER TYPE "FeedbackCategory_new" RENAME TO "FeedbackCategory";
DROP TYPE "FeedbackCategory_old";
ALTER TABLE "feedback_posts" ALTER COLUMN "category" SET DEFAULT 'FEATURE';

-- Statuses per type: bugs are Fixed (open until then), questions Answered.
-- A bug that had a feature status is Fixed if it shipped, otherwise open.
CREATE TYPE "FeedbackStatus_new" AS ENUM ('IN_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'FIXED', 'ANSWERED');
ALTER TABLE "feedback_posts" ALTER COLUMN "status" TYPE "FeedbackStatus_new"
  USING (CASE
    WHEN "category"::text = 'BUG' AND "status"::text = 'COMPLETED' THEN 'FIXED'
    WHEN "category"::text = 'BUG' THEN NULL
    ELSE "status"::text
  END)::"FeedbackStatus_new";
ALTER TYPE "FeedbackStatus" RENAME TO "FeedbackStatus_old";
ALTER TYPE "FeedbackStatus_new" RENAME TO "FeedbackStatus";
DROP TYPE "FeedbackStatus_old";

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FEEDBACK_REPLY';

-- AlterTable
ALTER TABLE "feedback_posts" ADD COLUMN     "bug_additional_info" TEXT,
ADD COLUMN     "bug_expected" TEXT,
ADD COLUMN     "bug_steps" TEXT,
ADD COLUMN     "bug_what_happened" TEXT,
ADD COLUMN     "duplicate_of_id" TEXT,
ADD COLUMN     "duplicated_at" TIMESTAMP(3),
ADD COLUMN     "duplicated_by_id" TEXT;

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "email_feedback_reply" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "feedback_updates" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "from_status" "FeedbackStatus",
    "to_status" "FeedbackStatus",
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_updates_post_id_created_at_idx" ON "feedback_updates"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_posts_duplicate_of_id_idx" ON "feedback_posts"("duplicate_of_id");

-- AddForeignKey
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "feedback_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_duplicated_by_id_fkey" FOREIGN KEY ("duplicated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_updates" ADD CONSTRAINT "feedback_updates_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feedback_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_updates" ADD CONSTRAINT "feedback_updates_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A post is never a duplicate of itself.
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_not_own_duplicate" CHECK ("duplicate_of_id" IS NULL OR "duplicate_of_id" <> "id");
