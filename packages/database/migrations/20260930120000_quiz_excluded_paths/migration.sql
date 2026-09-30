-- Paths a code-aware quiz's agent never sees in the student's repository:
-- glob patterns relative to the repository root, one per entry, like
-- .gitignore lines. Empty by default, so every existing quiz is unchanged.
-- AlterTable
ALTER TABLE "quizzes" ADD COLUMN     "excluded_paths" TEXT[] DEFAULT ARRAY[]::TEXT[];
