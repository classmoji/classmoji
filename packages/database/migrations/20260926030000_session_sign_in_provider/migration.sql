-- The provider a session signed in with (GITHUB | GITLAB): the session's mode.
-- A GitLab session is shown only GitLab classrooms and GitLab identity. Null for
-- sessions from before this column, which fall back to the user's provider.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "sign_in_provider" TEXT;
