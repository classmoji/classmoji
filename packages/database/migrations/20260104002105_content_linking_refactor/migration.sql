/*
  Warnings:

  - You are about to drop the column `module_id` on the `pages` table. All the data in the column will be lost.
  - You are about to drop the column `module` on the `slides` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[classroom_id,slug]` on the table `slides` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "pages" DROP CONSTRAINT "pages_module_id_fkey";

-- DropIndex
DROP INDEX "pages_module_id_idx";

-- DropIndex
DROP INDEX "slides_classroom_id_module_slug_key";

-- AlterTable
ALTER TABLE "pages" DROP COLUMN "module_id";

-- AlterTable
ALTER TABLE "slides" DROP COLUMN "module";

-- CreateTable
CREATE TABLE "page_links" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "module_id" TEXT,
    "assignment_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slide_links" (
    "id" TEXT NOT NULL,
    "slide_id" TEXT NOT NULL,
    "module_id" TEXT,
    "assignment_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slide_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_links_module_id_idx" ON "page_links"("module_id");

-- CreateIndex
CREATE INDEX "page_links_assignment_id_idx" ON "page_links"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_links_page_id_module_id_assignment_id_key" ON "page_links"("page_id", "module_id", "assignment_id");

-- CreateIndex
CREATE INDEX "slide_links_module_id_idx" ON "slide_links"("module_id");

-- CreateIndex
CREATE INDEX "slide_links_assignment_id_idx" ON "slide_links"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "slide_links_slide_id_module_id_assignment_id_key" ON "slide_links"("slide_id", "module_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "slides_classroom_id_slug_key" ON "slides"("classroom_id", "slug");

-- AddForeignKey
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_links" ADD CONSTRAINT "slide_links_slide_id_fkey" FOREIGN KEY ("slide_id") REFERENCES "slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_links" ADD CONSTRAINT "slide_links_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slide_links" ADD CONSTRAINT "slide_links_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
