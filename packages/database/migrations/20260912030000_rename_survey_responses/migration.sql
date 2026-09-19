-- Rename user_survey_responses -> survey_responses. Constraints and indexes are
-- renamed too so they match what Prisma generates for the new model name.
ALTER TABLE "user_survey_responses" RENAME TO "survey_responses";

ALTER TABLE "survey_responses" RENAME CONSTRAINT "user_survey_responses_pkey" TO "survey_responses_pkey";

ALTER TABLE "survey_responses" RENAME CONSTRAINT "user_survey_responses_user_id_fkey" TO "survey_responses_user_id_fkey";

ALTER INDEX "user_survey_responses_question_key_answer_idx" RENAME TO "survey_responses_question_key_answer_idx";

ALTER INDEX "user_survey_responses_user_id_question_key_key" RENAME TO "survey_responses_user_id_question_key_key";
