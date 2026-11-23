-- Team repo contributions, written by the `calculate_repo_contributions`
-- Trigger task: per-author lines, commits and active dates (JSON), when they
-- were calculated, and the last failure. Three nullable columns, no default:
-- a metadata-only change, nothing is rewritten.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "git_repos"
  ADD COLUMN "contribution_stats" JSONB,
  ADD COLUMN "contributions_calculated_at" TIMESTAMP(3),
  ADD COLUMN "contributions_error" TEXT;

COMMIT;
