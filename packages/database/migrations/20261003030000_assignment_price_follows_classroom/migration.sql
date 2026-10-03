-- An assignment's extension price (tokens per hour) is now optional: empty
-- means the classroom's default_tokens_per_hour applies, so changing that
-- setting reprices every assignment that has no price of its own. 0 stays a
-- deliberate "no extensions" for that assignment.
ALTER TABLE "assignments" ALTER COLUMN "tokens_per_hour" DROP NOT NULL,
ALTER COLUMN "tokens_per_hour" DROP DEFAULT;

-- Existing 0s were almost all a form default rather than a choice (new
-- assignments stopped picking up the classroom setting on 2026-09-19), so they
-- follow the classroom from now on. Non-zero prices stay as overrides.
UPDATE "assignments" SET "tokens_per_hour" = NULL WHERE "tokens_per_hour" = 0;
