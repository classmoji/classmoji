-- Forms as module items.
--
-- Additive only: a new ModuleItemType value, a nullable module_items.form_id,
-- its FK/unique index, and a widened exactly-one-target CHECK.
--
-- The CHECK is expressed purely over NULL-ness of the *_id columns and never
-- references an enum literal, so dropping and recreating it in the same
-- transaction that runs ALTER TYPE ... ADD VALUE is safe (Postgres only
-- forbids *using* a newly added enum value in the transaction that added it).

-- AlterEnum
ALTER TYPE "ModuleItemType" ADD VALUE IF NOT EXISTS 'FORM';

-- AlterTable
ALTER TABLE "module_items" ADD COLUMN "form_id" TEXT;

-- AddForeignKey
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_form_id_fkey"
  FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "module_items_module_id_form_id_key" ON "module_items"("module_id","form_id");

-- Widen the exactly-one-target CHECK to cover form_id.
ALTER TABLE "module_items" DROP CONSTRAINT IF EXISTS "module_items_one_target";
ALTER TABLE "module_items" ADD CONSTRAINT "module_items_one_target"
  CHECK ((("page_id" IS NOT NULL)::int + ("repository_id" IS NOT NULL)::int
        + ("quiz_id" IS NOT NULL)::int + ("slide_id" IS NOT NULL)::int
        + ("form_id" IS NOT NULL)::int) = 1);
