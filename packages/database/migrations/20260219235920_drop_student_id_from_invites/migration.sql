/*
  Warnings:

  - You are about to drop the column `student_id` on the `classroom_invites` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "classroom_invites_school_email_student_id_idx";

-- AlterTable
ALTER TABLE "classroom_invites" DROP COLUMN "student_id";
