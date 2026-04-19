-- CreateTable
CREATE TABLE "repo_analytics_snapshots" (
    "id" TEXT NOT NULL,
    "repository_assignment_id" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "default_branch" TEXT,
    "total_commits" INTEGER NOT NULL DEFAULT 0,
    "total_additions" INTEGER NOT NULL DEFAULT 0,
    "total_deletions" INTEGER NOT NULL DEFAULT 0,
    "first_commit_at" TIMESTAMP(3),
    "last_commit_at" TIMESTAMP(3),
    "commits" JSONB NOT NULL,
    "contributors" JSONB NOT NULL,
    "languages" JSONB NOT NULL,
    "pr_summary" JSONB NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "repo_analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_contributor_links" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_contributor_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_analytics_snapshots_repository_assignment_id_key" ON "repo_analytics_snapshots"("repository_assignment_id");

-- CreateIndex
CREATE INDEX "repo_analytics_snapshots_fetched_at_idx" ON "repo_analytics_snapshots"("fetched_at");

-- CreateIndex
CREATE INDEX "repository_contributor_links_user_id_idx" ON "repository_contributor_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "repository_contributor_links_repository_id_github_login_key" ON "repository_contributor_links"("repository_id", "github_login");

-- AddForeignKey
ALTER TABLE "repo_analytics_snapshots" ADD CONSTRAINT "repo_analytics_snapshots_repository_assignment_id_fkey" FOREIGN KEY ("repository_assignment_id") REFERENCES "repository_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_contributor_links" ADD CONSTRAINT "repository_contributor_links_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_contributor_links" ADD CONSTRAINT "repository_contributor_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
