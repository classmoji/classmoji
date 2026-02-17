/*
  Warnings:

  - Added the required column `student_name` to the `classroom_invites` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "classroom_invites" ADD COLUMN     "student_name" TEXT NOT NULL;
