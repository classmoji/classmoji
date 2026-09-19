-- CreateTable
CREATE TABLE "user_survey_responses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "question_key" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "detail" TEXT,
    "context" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_survey_responses_question_key_answer_idx" ON "user_survey_responses"("question_key", "answer");

-- CreateIndex
CREATE UNIQUE INDEX "user_survey_responses_user_id_question_key_key" ON "user_survey_responses"("user_id", "question_key");

-- AddForeignKey
ALTER TABLE "user_survey_responses" ADD CONSTRAINT "user_survey_responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
