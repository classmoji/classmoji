-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('IN_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('FEATURE', 'BUG', 'INTEGRATION');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FEEDBACK_STATUS_CHANGED';

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "email_feedback_status_changed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "feedback_posts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL DEFAULT 'FEATURE',
    "status" "FeedbackStatus",
    "author_id" TEXT,
    "vote_count" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_votes" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_comments" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "author_id" TEXT,
    "parent_id" TEXT,
    "body" TEXT NOT NULL,
    "vote_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_comment_votes" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_comment_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_follows" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_posts_status_idx" ON "feedback_posts"("status");

-- CreateIndex
CREATE INDEX "feedback_posts_vote_count_idx" ON "feedback_posts"("vote_count");

-- CreateIndex
CREATE INDEX "feedback_posts_created_at_idx" ON "feedback_posts"("created_at");

-- CreateIndex
CREATE INDEX "feedback_votes_user_id_idx" ON "feedback_votes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_votes_post_id_user_id_key" ON "feedback_votes"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "feedback_comments_post_id_idx" ON "feedback_comments"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_comment_votes_comment_id_user_id_key" ON "feedback_comment_votes"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "feedback_follows_user_id_idx" ON "feedback_follows"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_follows_post_id_user_id_key" ON "feedback_follows"("post_id", "user_id");

-- AddForeignKey
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feedback_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feedback_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "feedback_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comment_votes" ADD CONSTRAINT "feedback_comment_votes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "feedback_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_comment_votes" ADD CONSTRAINT "feedback_comment_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_follows" ADD CONSTRAINT "feedback_follows_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feedback_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_follows" ADD CONSTRAINT "feedback_follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

