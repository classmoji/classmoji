-- AlterTable
ALTER TABLE "modules" ADD COLUMN     "project_template_id" TEXT,
ADD COLUMN     "project_template_title" TEXT;

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "project_id" TEXT,
ADD COLUMN     "project_number" INTEGER;
