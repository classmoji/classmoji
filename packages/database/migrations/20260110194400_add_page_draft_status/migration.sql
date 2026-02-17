-- AlterTable
ALTER TABLE "classroom_settings" ADD COLUMN     "recent_viewers_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "is_draft" BOOLEAN NOT NULL DEFAULT true;
