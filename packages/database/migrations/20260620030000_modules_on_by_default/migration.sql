-- Modules tab now shows by default, matching pages and repos.
-- Flip the column default for new classrooms...
ALTER TABLE "classroom_settings" ALTER COLUMN "show_modules" SET DEFAULT true;

-- ...and turn it on for existing classrooms (the feature shipped off-by-default,
-- so every row is currently false; none were deliberately disabled). Owners can
-- still hide it from Settings → Content.
UPDATE "classroom_settings" SET "show_modules" = true WHERE "show_modules" = false;
