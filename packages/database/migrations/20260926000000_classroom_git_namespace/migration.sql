-- Full path of the namespace a classroom's student repos are created in when it
-- is not the org itself: on GitLab, the per-classroom subgroup. Null keeps the
-- existing Github behavior (repos directly in the org).

-- AlterTable
ALTER TABLE "classrooms" ADD COLUMN "git_namespace" TEXT;
