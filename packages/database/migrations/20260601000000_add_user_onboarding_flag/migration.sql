-- Track whether a user has completed (or skipped) the first-sign-in onboarding tour.
-- Null means the tour has not been completed; a timestamp records completion.
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

-- Existing users have already been using the app, so mark them as onboarded.
-- This keeps the tour from showing to current accounts; only brand-new accounts
-- created after this migration will start with a NULL value and see the tour.
UPDATE "users" SET "onboarding_completed_at" = now() WHERE "onboarding_completed_at" IS NULL;
