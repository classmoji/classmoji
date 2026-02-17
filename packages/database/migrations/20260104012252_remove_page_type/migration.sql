/*
  Warnings:

  - You are about to drop the column `type` on the `pages` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "pages" DROP COLUMN "type";

-- DropEnum
DROP TYPE "PageType";
