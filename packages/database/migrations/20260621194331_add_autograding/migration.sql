-- CreateEnum
CREATE TYPE "AutogradingMethod" AS ENUM ('COMMAND', 'IO', 'PYTHON', 'JAVA', 'NODE', 'C', 'CPP');

-- CreateEnum
CREATE TYPE "AutogradingComparison" AS ENUM ('INCLUDED', 'EXACT', 'REGEX');

-- CreateTable
CREATE TABLE "autograding_tests" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" "AutogradingMethod" NOT NULL DEFAULT 'COMMAND',
    "setup_command" TEXT,
    "run_command" TEXT,
    "input" TEXT,
    "expected_output" TEXT,
    "comparison_method" "AutogradingComparison" NOT NULL DEFAULT 'INCLUDED',
    "timeout" INTEGER NOT NULL DEFAULT 10,
    "points" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autograding_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autograding_results" (
    "id" TEXT NOT NULL,
    "git_repo_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "run_id" TEXT,
    "conclusion" TEXT NOT NULL,
    "total_tests" INTEGER,
    "passed_tests" INTEGER,
    "details" JSONB,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autograding_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autograding_tests_repository_id_idx" ON "autograding_tests"("repository_id");

-- CreateIndex
CREATE INDEX "autograding_results_git_repo_id_idx" ON "autograding_results"("git_repo_id");

-- AddForeignKey
ALTER TABLE "autograding_tests" ADD CONSTRAINT "autograding_tests_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autograding_results" ADD CONSTRAINT "autograding_results_git_repo_id_fkey" FOREIGN KEY ("git_repo_id") REFERENCES "git_repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
