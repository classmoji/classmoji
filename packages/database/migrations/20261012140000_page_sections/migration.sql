-- Per-student reader state on pages: checkable headings a student has ticked
-- and locked sections a student has opened. block_id is the BlockNote block id
-- in the page's content.json. One row per (page, user, block); a second unlock
-- of the same block keeps the first row and its time.
--
-- Unlock rows carry the page's classroom so staff views read one classroom's
-- rows by index. Rows outlive a student's membership (staff views count current
-- students only) and go with the page, the user or the classroom.

-- CreateTable
CREATE TABLE "page_section_checks" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_section_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_section_unlocks" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_section_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_section_checks_user_id_idx" ON "page_section_checks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_section_checks_page_id_user_id_block_id_key" ON "page_section_checks"("page_id", "user_id", "block_id");

-- CreateIndex
CREATE INDEX "page_section_unlocks_classroom_id_page_id_idx" ON "page_section_unlocks"("classroom_id", "page_id");

-- CreateIndex
CREATE INDEX "page_section_unlocks_user_id_idx" ON "page_section_unlocks"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_section_unlocks_page_id_user_id_block_id_key" ON "page_section_unlocks"("page_id", "user_id", "block_id");

-- AddForeignKey
ALTER TABLE "page_section_checks" ADD CONSTRAINT "page_section_checks_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_section_checks" ADD CONSTRAINT "page_section_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_section_unlocks" ADD CONSTRAINT "page_section_unlocks_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_section_unlocks" ADD CONSTRAINT "page_section_unlocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_section_unlocks" ADD CONSTRAINT "page_section_unlocks_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
