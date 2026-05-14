-- Rename refactor:
--   modules                       -> repositories
--   repositories (git)            -> git_repos
--   repository_assignments        -> git_repo_assignments
--   repository_contributor_links  -> git_repo_contributor_links
--   repository_assignment_graders -> git_repo_assignment_graders
--   repo_analytics_snapshots      -> git_repo_analytics_snapshots
--   module_id                     -> repository_id (assignments, quizzes, page_links, slide_links, git_repos)
--   repository_id (on git_repo_assignments) -> git_repo_id
--   repository_id (on git_repo_contributor_links) -> git_repo_id
--   repository_assignment_id      -> git_repo_assignment_id (assignment_grades, regrade_requests, token_transactions, git_repo_analytics_snapshots, git_repo_assignment_graders)
--   email_module_published        -> email_repository_published
--   email_module_unpublished      -> email_repository_unpublished

BEGIN;

-- ============================================================================
-- 1) Rename existing git-side tables (Repository* -> GitRepo*)
--    Do these first so the "repositories" name becomes free for modules.
-- ============================================================================

-- repo_analytics_snapshots -> git_repo_analytics_snapshots
ALTER TABLE "repo_analytics_snapshots" RENAME TO "git_repo_analytics_snapshots";
ALTER TABLE "git_repo_analytics_snapshots" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER INDEX "repo_analytics_snapshots_pkey" RENAME TO "git_repo_analytics_snapshots_pkey";
ALTER INDEX "repo_analytics_snapshots_fetched_at_idx" RENAME TO "git_repo_analytics_snapshots_fetched_at_idx";
ALTER INDEX "repo_analytics_snapshots_repository_assignment_id_key" RENAME TO "git_repo_analytics_snapshots_git_repo_assignment_id_key";
ALTER TABLE "git_repo_analytics_snapshots" RENAME CONSTRAINT "repo_analytics_snapshots_repository_assignment_id_fkey" TO "git_repo_analytics_snapshots_git_repo_assignment_id_fkey";

-- repository_assignment_graders -> git_repo_assignment_graders
ALTER TABLE "repository_assignment_graders" RENAME TO "git_repo_assignment_graders";
ALTER TABLE "git_repo_assignment_graders" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER INDEX "repository_assignment_graders_pkey" RENAME TO "git_repo_assignment_graders_pkey";
ALTER INDEX "repository_assignment_graders_repository_assignment_id_grad_key" RENAME TO "git_repo_assignment_graders_git_repo_assignment_id_grader_i_key";
ALTER TABLE "git_repo_assignment_graders" RENAME CONSTRAINT "repository_assignment_graders_grader_id_fkey" TO "git_repo_assignment_graders_grader_id_fkey";
ALTER TABLE "git_repo_assignment_graders" RENAME CONSTRAINT "repository_assignment_graders_repository_assignment_id_fkey" TO "git_repo_assignment_graders_git_repo_assignment_id_fkey";

-- repository_contributor_links -> git_repo_contributor_links
ALTER TABLE "repository_contributor_links" RENAME TO "git_repo_contributor_links";
ALTER TABLE "git_repo_contributor_links" RENAME COLUMN "repository_id" TO "git_repo_id";
ALTER INDEX "repository_contributor_links_pkey" RENAME TO "git_repo_contributor_links_pkey";
ALTER INDEX "repository_contributor_links_user_id_idx" RENAME TO "git_repo_contributor_links_user_id_idx";
ALTER INDEX "repository_contributor_links_repository_id_github_login_key" RENAME TO "git_repo_contributor_links_git_repo_id_github_login_key";
ALTER TABLE "git_repo_contributor_links" RENAME CONSTRAINT "repository_contributor_links_repository_id_fkey" TO "git_repo_contributor_links_git_repo_id_fkey";
ALTER TABLE "git_repo_contributor_links" RENAME CONSTRAINT "repository_contributor_links_user_id_fkey" TO "git_repo_contributor_links_user_id_fkey";

-- repository_assignments -> git_repo_assignments
ALTER TABLE "repository_assignments" RENAME TO "git_repo_assignments";
ALTER TABLE "git_repo_assignments" RENAME COLUMN "repository_id" TO "git_repo_id";
ALTER INDEX "repository_assignments_pkey" RENAME TO "git_repo_assignments_pkey";
ALTER INDEX "repository_assignments_assignment_id_idx" RENAME TO "git_repo_assignments_assignment_id_idx";
ALTER INDEX "repository_assignments_repository_id_idx" RENAME TO "git_repo_assignments_git_repo_id_idx";
ALTER INDEX "repository_assignments_provider_provider_id_key" RENAME TO "git_repo_assignments_provider_provider_id_key";
ALTER TABLE "git_repo_assignments" RENAME CONSTRAINT "repository_assignments_assignment_id_fkey" TO "git_repo_assignments_assignment_id_fkey";
ALTER TABLE "git_repo_assignments" RENAME CONSTRAINT "repository_assignments_repository_id_fkey" TO "git_repo_assignments_git_repo_id_fkey";

-- repositories (old git-side) -> git_repos
ALTER TABLE "repositories" RENAME TO "git_repos";
ALTER INDEX "repositories_pkey" RENAME TO "git_repos_pkey";
ALTER INDEX "repositories_classroom_id_idx" RENAME TO "git_repos_classroom_id_idx";
ALTER INDEX "repositories_module_id_idx" RENAME TO "git_repos_module_id_idx"; -- column renamed below
ALTER INDEX "repositories_student_id_idx" RENAME TO "git_repos_student_id_idx";
ALTER INDEX "repositories_provider_provider_id_key" RENAME TO "git_repos_provider_provider_id_key";
ALTER TABLE "git_repos" RENAME CONSTRAINT "repositories_classroom_id_fkey" TO "git_repos_classroom_id_fkey";
ALTER TABLE "git_repos" RENAME CONSTRAINT "repositories_module_id_fkey" TO "git_repos_repository_id_fkey"; -- will retarget after modules renamed
ALTER TABLE "git_repos" RENAME CONSTRAINT "repositories_student_id_fkey" TO "git_repos_student_id_fkey";
ALTER TABLE "git_repos" RENAME CONSTRAINT "repositories_team_id_fkey" TO "git_repos_team_id_fkey";

-- Rename column module_id -> repository_id on git_repos and update index name
ALTER TABLE "git_repos" RENAME COLUMN "module_id" TO "repository_id";
ALTER INDEX "git_repos_module_id_idx" RENAME TO "git_repos_repository_id_idx";

-- Rename repository_assignment_id columns and indexes/constraints on referencing tables
ALTER TABLE "assignment_grades" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER TABLE "assignment_grades" RENAME CONSTRAINT "assignment_grades_repository_assignment_id_fkey" TO "assignment_grades_git_repo_assignment_id_fkey";

ALTER TABLE "regrade_requests" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER TABLE "regrade_requests" RENAME CONSTRAINT "regrade_requests_repository_assignment_id_fkey" TO "regrade_requests_git_repo_assignment_id_fkey";

ALTER TABLE "token_transactions" RENAME COLUMN "repository_assignment_id" TO "git_repo_assignment_id";
ALTER TABLE "token_transactions" RENAME CONSTRAINT "token_transactions_repository_assignment_id_fkey" TO "token_transactions_git_repo_assignment_id_fkey";

-- ============================================================================
-- 2) Rename modules -> repositories (and module_id -> repository_id everywhere)
-- ============================================================================

ALTER TABLE "modules" RENAME TO "repositories";
ALTER INDEX "modules_pkey" RENAME TO "repositories_pkey";
ALTER INDEX "modules_classroom_id_idx" RENAME TO "repositories_classroom_id_idx";
ALTER INDEX "modules_classroom_id_title_key" RENAME TO "repositories_classroom_id_title_key";
ALTER TABLE "repositories" RENAME CONSTRAINT "modules_classroom_id_fkey" TO "repositories_classroom_id_fkey";
ALTER TABLE "repositories" RENAME CONSTRAINT "modules_tag_id_fkey" TO "repositories_tag_id_fkey";

-- assignments.module_id -> assignments.repository_id
ALTER TABLE "assignments" RENAME COLUMN "module_id" TO "repository_id";
ALTER INDEX "assignments_module_id_idx" RENAME TO "assignments_repository_id_idx";
ALTER INDEX "assignments_module_id_title_key" RENAME TO "assignments_repository_id_title_key";
ALTER TABLE "assignments" RENAME CONSTRAINT "assignments_module_id_fkey" TO "assignments_repository_id_fkey";

-- quizzes.module_id -> quizzes.repository_id
ALTER TABLE "quizzes" RENAME COLUMN "module_id" TO "repository_id";
ALTER INDEX "quizzes_module_id_idx" RENAME TO "quizzes_repository_id_idx";
ALTER TABLE "quizzes" RENAME CONSTRAINT "quizzes_module_id_fkey" TO "quizzes_repository_id_fkey";

-- page_links.module_id -> page_links.repository_id
ALTER TABLE "page_links" RENAME COLUMN "module_id" TO "repository_id";
ALTER INDEX "page_links_module_id_idx" RENAME TO "page_links_repository_id_idx";
ALTER INDEX "page_links_page_id_module_id_assignment_id_key" RENAME TO "page_links_page_id_repository_id_assignment_id_key";
ALTER TABLE "page_links" RENAME CONSTRAINT "page_links_module_id_fkey" TO "page_links_repository_id_fkey";

-- slide_links.module_id -> slide_links.repository_id
ALTER TABLE "slide_links" RENAME COLUMN "module_id" TO "repository_id";
ALTER INDEX "slide_links_module_id_idx" RENAME TO "slide_links_repository_id_idx";
ALTER INDEX "slide_links_slide_id_module_id_assignment_id_key" RENAME TO "slide_links_slide_id_repository_id_assignment_id_key";
ALTER TABLE "slide_links" RENAME CONSTRAINT "slide_links_module_id_fkey" TO "slide_links_repository_id_fkey";

-- ============================================================================
-- 3) Rename notification_preferences columns
-- ============================================================================

ALTER TABLE "notification_preferences" RENAME COLUMN "email_module_published" TO "email_repository_published";
ALTER TABLE "notification_preferences" RENAME COLUMN "email_module_unpublished" TO "email_repository_unpublished";

COMMIT;
