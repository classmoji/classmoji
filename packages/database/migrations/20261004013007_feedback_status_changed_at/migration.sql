-- AlterTable
ALTER TABLE "feedback_posts" ADD COLUMN     "status_changed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "feedback_posts_status_status_changed_at_idx" ON "feedback_posts"("status", "status_changed_at");

