-- CreateEnum
CREATE TYPE "ClassroomStatus" AS ENUM ('ACTIVE', 'LOCKED', 'UNPUBLISHED');

-- AlterTable: add new columns with defaults
ALTER TABLE "classrooms"
  ADD COLUMN "status" "ClassroomStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: prior is_active=false ⇒ archived
UPDATE "classrooms" SET "is_archived" = NOT "is_active";

-- Drop the old column
ALTER TABLE "classrooms" DROP COLUMN "is_active";
