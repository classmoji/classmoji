-- Page comments: threads readers start on a page (on a block, a quote inside
-- a block, or the page as a whole), their comments and emoji reactions.
-- Nothing is written into the page document: block_id is the BlockNote block
-- id in the page's content.json, quote/quote_occurrence locate the selected
-- text in that block at render time. locked_section_id is the lockedSection
-- enclosing the block when the thread was started, so a thread on a
-- since-deleted block stays gated for readers who never unlocked it.
--
-- Threads carry the page's classroom (copied from the page row) and go with
-- the page or the classroom; comments and reactions go with their thread and
-- comment. A deleted user's threads and comments stay with a null author.

-- CreateTable
CREATE TABLE "page_comment_threads" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "block_id" TEXT,
    "quote" TEXT,
    "quote_occurrence" INTEGER NOT NULL DEFAULT 0,
    "locked_section_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,

    CONSTRAINT "page_comment_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_comments" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "page_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_comment_reactions" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_comment_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_comment_threads_page_id_resolved_at_idx" ON "page_comment_threads"("page_id", "resolved_at");

-- CreateIndex
CREATE INDEX "page_comment_threads_classroom_id_idx" ON "page_comment_threads"("classroom_id");

-- CreateIndex
CREATE INDEX "page_comment_threads_created_by_id_idx" ON "page_comment_threads"("created_by_id");

-- CreateIndex
CREATE INDEX "page_comment_threads_resolved_by_id_idx" ON "page_comment_threads"("resolved_by_id");

-- CreateIndex
CREATE INDEX "page_comments_thread_id_created_at_idx" ON "page_comments"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "page_comments_author_id_idx" ON "page_comments"("author_id");

-- CreateIndex
CREATE INDEX "page_comment_reactions_user_id_idx" ON "page_comment_reactions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_comment_reactions_comment_id_user_id_emoji_key" ON "page_comment_reactions"("comment_id", "user_id", "emoji");

-- AddForeignKey
ALTER TABLE "page_comment_threads" ADD CONSTRAINT "page_comment_threads_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comment_threads" ADD CONSTRAINT "page_comment_threads_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comment_threads" ADD CONSTRAINT "page_comment_threads_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comment_threads" ADD CONSTRAINT "page_comment_threads_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "page_comment_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comment_reactions" ADD CONSTRAINT "page_comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "page_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comment_reactions" ADD CONSTRAINT "page_comment_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

