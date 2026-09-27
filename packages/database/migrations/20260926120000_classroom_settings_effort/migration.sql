-- Per-classroom reasoning effort for the quiz agents: question_effort for the
-- question and conversation turns (standard and code-aware), grading_effort for
-- the final grading (both), exploration_effort for the code-aware exploration
-- excerpt call. Values are low|medium|high|xhigh|max, checked by the settings
-- action, not here.
--
-- Nullable: null means "not set", and the ai-agent's platform default applies
-- (QUIZ_QUESTION_EFFORT, QUIZ_GRADING_EFFORT, EXPLORATION_EFFORT).
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_settings" ADD COLUMN "question_effort" TEXT,
ADD COLUMN "grading_effort" TEXT,
ADD COLUMN "exploration_effort" TEXT;
