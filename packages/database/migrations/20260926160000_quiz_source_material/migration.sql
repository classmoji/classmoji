-- Quiz source material: the pages and slide decks a quiz is about.
--
-- A quiz links documents through the same two tables that already mean "this
-- document is attached to that thing" (page_links, slide_links), as a third
-- nullable target beside repository_id and assignment_id. `order` is the
-- document's position in the quiz's material, one ordered list across both
-- tables. Deleting the quiz deletes its links; deleting a page or deck deletes
-- its links, as before.
--
-- The existing (resource_id, repository_id, assignment_id) unique indexes are
-- nulls-distinct and so constrain nothing; they are left exactly as they are.
-- A quiz link gets its own PARTIAL unique index instead, so a document appears
-- at most once in one quiz's material. Prisma cannot express a partial index,
-- so these two live only in this SQL (precedent: calendar_link_featured).
--
-- `course_search_enabled` lets the quiz agent search the whole classroom's
-- content, not only the linked documents. Off for every existing quiz.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "quizzes" ADD COLUMN     "course_search_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "page_links" ADD COLUMN     "quiz_id" TEXT;

-- AlterTable
ALTER TABLE "slide_links" ADD COLUMN     "quiz_id" TEXT;

-- CreateIndex
CREATE INDEX "page_links_quiz_id_idx" ON "page_links"("quiz_id");

-- CreateIndex
CREATE INDEX "slide_links_quiz_id_idx" ON "slide_links"("quiz_id");

-- CreateIndex (partial, hand-written)
CREATE UNIQUE INDEX "page_links_quiz_unique" ON "page_links"("page_id", "quiz_id") WHERE "quiz_id" IS NOT NULL;

-- CreateIndex (partial, hand-written)
CREATE UNIQUE INDEX "slide_links_quiz_unique" ON "slide_links"("slide_id", "quiz_id") WHERE "quiz_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_links" ADD CONSTRAINT "slide_links_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
