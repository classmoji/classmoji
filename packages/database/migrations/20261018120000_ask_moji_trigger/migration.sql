-- Ask Moji on the Trigger runtime: the owner's instructions, ratings on
-- answers, and the message index the in-flight state and the insights read.

-- The owner's instructions Ask Moji follows (validated to 4,000 characters in
-- classroom.updateSettings). Owner-only; never copied by an import.
ALTER TABLE "classroom_settings" ADD COLUMN "syllabus_bot_instructions" TEXT;

-- A thumbs up or down on one answer, by the conversation's owner.
CREATE TYPE "ASK_MOJI_RATING" AS ENUM ('UP', 'DOWN');

CREATE TABLE "ask_moji_feedback" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "ui_message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rating" "ASK_MOJI_RATING" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_moji_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ask_moji_feedback_conversation_id_ui_message_id_key" ON "ask_moji_feedback"("conversation_id", "ui_message_id");
CREATE INDEX "ask_moji_feedback_classroom_id_rating_created_at_idx" ON "ask_moji_feedback"("classroom_id", "rating", "created_at");
CREATE INDEX "ask_moji_feedback_user_id_idx" ON "ask_moji_feedback"("user_id");

ALTER TABLE "ask_moji_feedback" ADD CONSTRAINT "ask_moji_feedback_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ask_moji_feedback" ADD CONSTRAINT "ask_moji_feedback_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ask_moji_feedback" ADD CONSTRAINT "ask_moji_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reads by role in time order (the latest user row of a conversation, the
-- insights' weekly counts). Its leading column, like the unique
-- (conversation_id, ui_message_id) key's, serves conversation-only lookups, so
-- the single-column index is redundant and goes.
CREATE INDEX "ai_conversation_messages_conversation_id_role_created_at_idx" ON "ai_conversation_messages"("conversation_id", "role", "created_at");
DROP INDEX "ai_conversation_messages_conversation_id_idx";
