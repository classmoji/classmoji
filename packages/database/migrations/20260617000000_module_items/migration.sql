-- CreateEnum
CREATE TYPE "ModuleItemType" AS ENUM ('PAGE','REPOSITORY','QUIZ','SLIDE');

-- CreateTable
CREATE TABLE "module_items" (
  "id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "item_type" "ModuleItemType" NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "page_id" TEXT,
  "repository_id" TEXT,
  "quiz_id" TEXT,
  "slide_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "module_items_pkey" PRIMARY KEY ("id")
);

-- Enforce exactly one target per item
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_one_target"
  CHECK ((("page_id" IS NOT NULL)::int + ("repository_id" IS NOT NULL)::int
        + ("quiz_id" IS NOT NULL)::int + ("slide_id" IS NOT NULL)::int) = 1);

-- AlterTable: new flags
ALTER TABLE "modules" ADD COLUMN "is_published" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "classroom_settings" ADD COLUMN "show_modules" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "classroom_settings" ADD COLUMN "show_pages"   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "classroom_settings" ADD COLUMN "show_repos"   BOOLEAN NOT NULL DEFAULT true;

-- Backfill repositories that had a module_id (as REPOSITORY items, ordered by title)
INSERT INTO "module_items" ("id","module_id","item_type","position","repository_id")
SELECT gen_random_uuid(), r."module_id", 'REPOSITORY',
       row_number() OVER (PARTITION BY r."module_id" ORDER BY r."title") - 1, r."id"
FROM "repositories" r WHERE r."module_id" IS NOT NULL;

-- Backfill page_links that had a module_id (as PAGE items, position offset by 1000)
INSERT INTO "module_items" ("id","module_id","item_type","position","page_id")
SELECT gen_random_uuid(), pl."module_id", 'PAGE',
       1000 + (row_number() OVER (PARTITION BY pl."module_id" ORDER BY pl."order") - 1), pl."page_id"
FROM "page_links" pl WHERE pl."module_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_slide_id_fkey" FOREIGN KEY ("slide_id") REFERENCES "slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "module_items_module_id_idx" ON "module_items"("module_id");
CREATE UNIQUE INDEX "module_items_module_id_page_id_key"       ON "module_items"("module_id","page_id");
CREATE UNIQUE INDEX "module_items_module_id_repository_id_key" ON "module_items"("module_id","repository_id");
CREATE UNIQUE INDEX "module_items_module_id_quiz_id_key"       ON "module_items"("module_id","quiz_id");
CREATE UNIQUE INDEX "module_items_module_id_slide_id_key"      ON "module_items"("module_id","slide_id");

-- Replace old page_links composite unique to match new @@unique([page_id, repository_id, assignment_id])
DROP INDEX IF EXISTS "page_links_page_id_repository_id_assignment_id_module_id_key";
CREATE UNIQUE INDEX "page_links_page_id_repository_id_assignment_id_key" ON "page_links"("page_id","repository_id","assignment_id");

-- Drop old module_id membership columns and their constraints/indexes
DROP INDEX IF EXISTS "page_links_module_id_idx";
ALTER TABLE "page_links" DROP CONSTRAINT IF EXISTS "page_links_module_id_fkey";
ALTER TABLE "page_links" DROP COLUMN "module_id";
DROP INDEX IF EXISTS "repositories_module_id_idx";
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_module_id_fkey";
ALTER TABLE "repositories" DROP COLUMN "module_id";
