-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "impersonated_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ban_expires_at" TIMESTAMP(3),
ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "banned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role" TEXT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_by_user_id_fkey" FOREIGN KEY ("impersonated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
