-- AlterTable
ALTER TABLE "classroom_settings" ALTER COLUMN "theme" SET DEFAULT 'stone';

-- Backfill rows still on the old auto-default (no one has intentionally picked 'classic' yet)
UPDATE "classroom_settings" SET "theme" = 'stone' WHERE "theme" = 'classic';
