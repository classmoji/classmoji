-- Bugs that were given a feature status move to the bug one: shipped is
-- Fixed; anything before that is simply open again (bugs have no other
-- status). Separate from the migration that adds the value: Postgres refuses
-- a new enum value in the transaction that added it.
UPDATE "feedback_posts" SET "status" = 'FIXED'
  WHERE "category" = 'BUG' AND "status" = 'COMPLETED';
UPDATE "feedback_posts" SET "status" = NULL
  WHERE "category" = 'BUG' AND "status" IN ('IN_REVIEW', 'PLANNED', 'IN_PROGRESS');
