-- Per-classroom model for the code-aware quiz's repository-exploration
-- sub-agent, alongside llm_model (standard quizzes) and code_aware_model (the
-- code-aware discussion agent).
--
-- Nullable: null means "not set", and the platform EXPLORATION_MODEL applies.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_settings" ADD COLUMN "exploration_model" TEXT;
