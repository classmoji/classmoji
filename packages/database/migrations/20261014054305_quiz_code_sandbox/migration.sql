-- Code sandbox questions: off for every existing and new quiz.
ALTER TABLE "quizzes" ADD COLUMN     "code_sandbox_enabled" BOOLEAN NOT NULL DEFAULT false;
