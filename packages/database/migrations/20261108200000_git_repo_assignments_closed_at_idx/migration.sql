-- The admin dashboard counts submissions per week by closed_at; without an
-- index each Home load scanned every submission row.
CREATE INDEX "git_repo_assignments_closed_at_idx" ON "git_repo_assignments"("closed_at");
