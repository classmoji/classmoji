-- Reverse of 20260514154114_rename_modules_to_repositories

BEGIN;

-- 3) notification_preferences
ALTER TABLE "notification_preferences" RENAME COLUMN "email_repository_published" TO "email_module_published";
ALTER TABLE "notification_preferences" RENAME COLUMN "email_repository_unpublished" TO "email_module_unpublished";

-- 2) repositories -> modules
ALTER TABLE "slide_links" RENAME CONSTRAINT "slide_links_repository_id_fkey" TO "slide_links_module_id_fkey";
ALTER INDEX "slide_links_slide_id_repository_id_assignment_id_key" RENAME TO "slide_links_slide_id_module_id_assignment_id_key";
ALTER INDEX "slide_links_repository_id_idx" RENAME TO "slide_links_module_id_idx";
ALTER TABLE "slide_links" RENAME COLUMN "repository_id" TO "module_id";

ALTER TABLE "page_links" RENAME CONSTRAINT "page_links_repository_id_fkey" TO "page_links_module_id_fkey";
ALTER INDEX "page_links_page_id_repository_id_assignment_id_key" RENAME TO "page_links_page_id_module_id_assignment_id_key";
ALTER INDEX "page_links_repository_id_idx" RENAME TO "page_links_module_id_idx";
ALTER TABLE "page_links" RENAME COLUMN "repository_id" TO "module_id";

ALTER TABLE "quizzes" RENAME CONSTRAINT "quizzes_repository_id_fkey" TO "quizzes_module_id_fkey";
ALTER INDEX "quizzes_repository_id_idx" RENAME TO "quizzes_module_id_idx";
ALTER TABLE "quizzes" RENAME COLUMN "repository_id" TO "module_id";

ALTER TABLE "assignments" RENAME CONSTRAINT "assignments_repository_id_fkey" TO "assignments_module_id_fkey";
ALTER INDEX "assignments_repository_id_title_key" RENAME TO "assignments_module_id_title_key";
ALTER INDEX "assignments_repository_id_idx" RENAME TO "assignments_module_id_idx";
ALTER TABLE "assignments" RENAME COLUMN "repository_id" TO "module_id";

ALTER TABLE "repositories" RENAME CONSTRAINT "repositories_tag_id_fkey" TO "modules_tag_id_fkey";
ALTER TABLE "repositories" RENAME CONSTRAINT "repositories_classroom_id_fkey" TO "modules_classroom_id_fkey";
ALTER INDEX "repositories_classroom_id_title_key" RENAME TO "modules_classroom_id_title_key";
ALTER INDEX "repositories_classroom_id_idx" RENAME TO "modules_classroom_id_idx";
ALTER INDEX "repositories_pkey" RENAME TO "modules_pkey";
ALTER TABLE "repositories" RENAME TO "modules";

-- 1) git_repo* -> repository*/repo_*
ALTER TABLE "token_transactions" RENAME CONSTRAINT "token_transactions_git_repo_assignment_id_fkey" TO "token_transactions_repository_assignment_id_fkey";
ALTER TABLE "token_transactions" RENAME COLUMN "git_repo_assignment_id" TO "repository_assignment_id";

ALTER TABLE "regrade_requests" RENAME CONSTRAINT "regrade_requests_git_repo_assignment_id_fkey" TO "regrade_requests_repository_assignment_id_fkey";
ALTER TABLE "regrade_requests" RENAME COLUMN "git_repo_assignment_id" TO "repository_assignment_id";

ALTER TABLE "assignment_grades" RENAME CONSTRAINT "assignment_grades_git_repo_assignment_id_fkey" TO "assignment_grades_repository_assignment_id_fkey";
ALTER TABLE "assignment_grades" RENAME COLUMN "git_repo_assignment_id" TO "repository_assignment_id";

ALTER INDEX "git_repos_repository_id_idx" RENAME TO "git_repos_module_id_idx";
ALTER TABLE "git_repos" RENAME COLUMN "repository_id" TO "module_id";

ALTER TABLE "git_repos" RENAME CONSTRAINT "git_repos_team_id_fkey" TO "repositories_team_id_fkey";
ALTER TABLE "git_repos" RENAME CONSTRAINT "git_repos_student_id_fkey" TO "repositories_student_id_fkey";
ALTER TABLE "git_repos" RENAME CONSTRAINT "git_repos_repository_id_fkey" TO "repositories_module_id_fkey";
ALTER TABLE "git_repos" RENAME CONSTRAINT "git_repos_classroom_id_fkey" TO "repositories_classroom_id_fkey";
ALTER INDEX "git_repos_provider_provider_id_key" RENAME TO "repositories_provider_provider_id_key";
ALTER INDEX "git_repos_student_id_idx" RENAME TO "repositories_student_id_idx";
ALTER INDEX "git_repos_module_id_idx" RENAME TO "repositories_module_id_idx";
ALTER INDEX "git_repos_classroom_id_idx" RENAME TO "repositories_classroom_id_idx";
ALTER INDEX "git_repos_pkey" RENAME TO "repositories_pkey";
ALTER TABLE "git_repos" RENAME TO "repositories";

ALTER TABLE "git_repo_assignments" RENAME CONSTRAINT "git_repo_assignments_git_repo_id_fkey" TO "repository_assignments_repository_id_fkey";
ALTER TABLE "git_repo_assignments" RENAME CONSTRAINT "git_repo_assignments_assignment_id_fkey" TO "repository_assignments_assignment_id_fkey";
ALTER INDEX "git_repo_assignments_provider_provider_id_key" RENAME TO "repository_assignments_provider_provider_id_key";
ALTER INDEX "git_repo_assignments_git_repo_id_idx" RENAME TO "repository_assignments_repository_id_idx";
ALTER INDEX "git_repo_assignments_assignment_id_idx" RENAME TO "repository_assignments_assignment_id_idx";
ALTER INDEX "git_repo_assignments_pkey" RENAME TO "repository_assignments_pkey";
ALTER TABLE "git_repo_assignments" RENAME COLUMN "git_repo_id" TO "repository_id";
ALTER TABLE "git_repo_assignments" RENAME TO "repository_assignments";

ALTER TABLE "git_repo_contributor_links" RENAME CONSTRAINT "git_repo_contributor_links_user_id_fkey" TO "repository_contributor_links_user_id_fkey";
ALTER TABLE "git_repo_contributor_links" RENAME CONSTRAINT "git_repo_contributor_links_git_repo_id_fkey" TO "repository_contributor_links_repository_id_fkey";
ALTER INDEX "git_repo_contributor_links_git_repo_id_github_login_key" RENAME TO "repository_contributor_links_repository_id_github_login_key";
ALTER INDEX "git_repo_contributor_links_user_id_idx" RENAME TO "repository_contributor_links_user_id_idx";
ALTER INDEX "git_repo_contributor_links_pkey" RENAME TO "repository_contributor_links_pkey";
ALTER TABLE "git_repo_contributor_links" RENAME COLUMN "git_repo_id" TO "repository_id";
ALTER TABLE "git_repo_contributor_links" RENAME TO "repository_contributor_links";

ALTER TABLE "git_repo_assignment_graders" RENAME CONSTRAINT "git_repo_assignment_graders_git_repo_assignment_id_fkey" TO "repository_assignment_graders_repository_assignment_id_fkey";
ALTER TABLE "git_repo_assignment_graders" RENAME CONSTRAINT "git_repo_assignment_graders_grader_id_fkey" TO "repository_assignment_graders_grader_id_fkey";
ALTER INDEX "git_repo_assignment_graders_git_repo_assignment_id_grader_i_key" RENAME TO "repository_assignment_graders_repository_assignment_id_grad_key";
ALTER INDEX "git_repo_assignment_graders_pkey" RENAME TO "repository_assignment_graders_pkey";
ALTER TABLE "git_repo_assignment_graders" RENAME COLUMN "git_repo_assignment_id" TO "repository_assignment_id";
ALTER TABLE "git_repo_assignment_graders" RENAME TO "repository_assignment_graders";

ALTER TABLE "git_repo_analytics_snapshots" RENAME CONSTRAINT "git_repo_analytics_snapshots_git_repo_assignment_id_fkey" TO "repo_analytics_snapshots_repository_assignment_id_fkey";
ALTER INDEX "git_repo_analytics_snapshots_git_repo_assignment_id_key" RENAME TO "repo_analytics_snapshots_repository_assignment_id_key";
ALTER INDEX "git_repo_analytics_snapshots_fetched_at_idx" RENAME TO "repo_analytics_snapshots_fetched_at_idx";
ALTER INDEX "git_repo_analytics_snapshots_pkey" RENAME TO "repo_analytics_snapshots_pkey";
ALTER TABLE "git_repo_analytics_snapshots" RENAME COLUMN "git_repo_assignment_id" TO "repository_assignment_id";
ALTER TABLE "git_repo_analytics_snapshots" RENAME TO "repo_analytics_snapshots";

COMMIT;
