/*
  Warnings:

  - The values [GRANT] on the enum `TokenTransactionType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `branch` on the `assignments` table. All the data in the column will be lost.
  - You are about to drop the column `workflow_file` on the `assignments` table. All the data in the column will be lost.
  - You are about to drop the column `emoji` on the `classrooms` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `git_organizations` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TokenTransactionType_new" AS ENUM ('GAIN', 'PURCHASE', 'REFUND', 'REMOVAL');
-- Convert GRANT to GAIN during type conversion using CASE expression
ALTER TABLE "token_transactions" ALTER COLUMN "type" TYPE "TokenTransactionType_new"
  USING (CASE WHEN "type"::text = 'GRANT' THEN 'GAIN' ELSE "type"::text END)::"TokenTransactionType_new";
ALTER TYPE "TokenTransactionType" RENAME TO "TokenTransactionType_old";
ALTER TYPE "TokenTransactionType_new" RENAME TO "TokenTransactionType";
DROP TYPE "public"."TokenTransactionType_old";
COMMIT;

-- AlterTable (use IF EXISTS since columns may already be dropped)
ALTER TABLE "assignments" DROP COLUMN IF EXISTS "branch",
DROP COLUMN IF EXISTS "workflow_file";

-- AlterTable
ALTER TABLE "classrooms" DROP COLUMN IF EXISTS "emoji";

-- AlterTable
ALTER TABLE "git_organizations" DROP COLUMN IF EXISTS "name";
