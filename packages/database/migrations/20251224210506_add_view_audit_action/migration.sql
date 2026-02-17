-- AlterEnum
ALTER TYPE "AuditLogAction" ADD VALUE 'VIEW';

-- AlterTable
ALTER TABLE "slides" ALTER COLUMN "title" DROP DEFAULT;
