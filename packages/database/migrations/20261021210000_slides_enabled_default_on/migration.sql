-- New classes start with Slides on. Existing classes keep the setting they have.
ALTER TABLE "classroom_settings" ALTER COLUMN "slides_enabled" SET DEFAULT true;
