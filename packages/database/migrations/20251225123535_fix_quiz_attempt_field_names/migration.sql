-- Fix QuizAttempt field names to match service code expectations
-- Rename existing columns (preserves data)
ALTER TABLE "quiz_attempts" RENAME COLUMN "partial_percentage" TO "partial_credit_percentage";
ALTER TABLE "quiz_attempts" RENAME COLUMN "question_results" TO "question_results_json";

-- Add missing columns
ALTER TABLE "quiz_attempts" ADD COLUMN "first_attempt_percentage" DOUBLE PRECISION;
ALTER TABLE "quiz_attempts" ADD COLUMN "session_status" TEXT DEFAULT 'active';

-- Drop unused columns (these were never used in code)
ALTER TABLE "quiz_attempts" DROP COLUMN IF EXISTS "correct_percentage";
ALTER TABLE "quiz_attempts" DROP COLUMN IF EXISTS "incorrect_percentage";
