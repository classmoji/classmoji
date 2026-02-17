-- Fix schema drift: add missing slides.title column
ALTER TABLE "slides" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- Fix schema drift: rename sessions.impersonated_by_user_id to impersonated_by (to match schema @map)
ALTER TABLE "sessions" RENAME COLUMN "impersonated_by_user_id" TO "impersonated_by";

-- Update foreign key constraint to use correct column name
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_impersonated_by_user_id_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_by_fkey" FOREIGN KEY ("impersonated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
