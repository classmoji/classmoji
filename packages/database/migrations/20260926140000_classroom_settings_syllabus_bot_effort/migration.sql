-- Ask Moji's reasoning effort, per classroom: low|medium|high|xhigh|max, checked
-- by the AI settings action, not here.
--
-- Nullable: null means "not set", and the ai-agent's platform default applies
-- (SYLLABUS_BOT_EFFORT).
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_settings" ADD COLUMN "syllabus_bot_effort" TEXT;
