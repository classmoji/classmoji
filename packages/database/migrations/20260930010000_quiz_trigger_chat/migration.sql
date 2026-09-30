-- Quiz attempts served as chat agents on Trigger.dev.
--
-- Additive only: every new column is nullable or has a constant default, so the
-- existing quiz path keeps working unchanged while this is deployed.
--
-- quiz_attempts: the runtime stamp (ai_agent | trigger_chat, set at creation),
-- the contract version the attempt is graded under, the evaluation record, the
-- chat session id and expiry, the per-turn fence and the chat grant.
--
-- ai_conversation_messages: UIMessage parts beside the legacy text body, with
-- the message's own id (unique per conversation, never global), a partial flag,
-- provenance and contract version.
--
-- quiz_attempt_events: an append-only journal, one row per accepted outcome,
-- unique per attempt by operation id and by sequence number.
-- AlterTable
ALTER TABLE "quiz_attempts" ADD COLUMN     "agent_runtime" TEXT NOT NULL DEFAULT 'ai_agent',
ADD COLUMN     "chat_grant" JSONB,
ADD COLUMN     "contract_version" INTEGER,
ADD COLUMN     "evaluation_json" JSONB,
ADD COLUMN     "session_expires_at" TIMESTAMP(3),
ADD COLUMN     "trigger_session_id" TEXT,
ADD COLUMN     "turn_fence" TEXT;

-- AlterTable
ALTER TABLE "ai_conversation_messages" ADD COLUMN     "contract_version" INTEGER,
ADD COLUMN     "final" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'legacy_text',
ADD COLUMN     "parts" JSONB,
ADD COLUMN     "provenance" TEXT,
ADD COLUMN     "ui_message_id" TEXT;

-- CreateTable
CREATE TABLE "quiz_attempt_events" (
    "id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "tool_call_id" TEXT,
    "turn_fence" TEXT,
    "input_message_id" TEXT,
    "run_id" TEXT,
    "contract_version" INTEGER,
    "payload" JSONB NOT NULL,
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_attempt_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_attempt_events_attempt_id_type_idx" ON "quiz_attempt_events"("attempt_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_attempt_events_attempt_id_operation_id_key" ON "quiz_attempt_events"("attempt_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_attempt_events_attempt_id_seq_key" ON "quiz_attempt_events"("attempt_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ai_conversation_messages_conversation_id_ui_message_id_key" ON "ai_conversation_messages"("conversation_id", "ui_message_id");

-- AddForeignKey
ALTER TABLE "quiz_attempt_events" ADD CONSTRAINT "quiz_attempt_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quiz_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

