-- "Last push" on the assignment page used to be the submission time (or a
-- stale analytics snapshot), so a push after the deadline, which does not
-- move a frozen submission, never showed. The webhook now stamps the repo
-- itself.
ALTER TABLE "git_repos" ADD COLUMN "last_push_at" TIMESTAMP(3);
