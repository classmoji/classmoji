-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "slides" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT false;
