-- Final grades released to students (owner action on the gradebook).
--
-- Off by default: a classroom's letter overrides stay staff-only until its
-- owner releases final grades.

-- AlterTable
ALTER TABLE "classroom_settings" ADD COLUMN "final_grades_released" BOOLEAN NOT NULL DEFAULT false;
