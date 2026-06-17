-- DropIndex
DROP INDEX "page_links_page_id_repository_id_assignment_id_key";

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "module_id" TEXT;

-- AlterTable
ALTER TABLE "page_links" ADD COLUMN     "module_id" TEXT;

-- CreateTable
CREATE TABLE "modules" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "modules_classroom_id_idx" ON "modules"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "modules_classroom_id_title_key" ON "modules"("classroom_id", "title");

-- CreateIndex
CREATE INDEX "repositories_module_id_idx" ON "repositories"("module_id");

-- CreateIndex
CREATE INDEX "page_links_module_id_idx" ON "page_links"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "page_links_page_id_repository_id_assignment_id_module_id_key" ON "page_links"("page_id", "repository_id", "assignment_id", "module_id");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modules" ADD CONSTRAINT "modules_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

