-- AlterEnum: a status for bugs (fixed) and for questions (answered).
ALTER TYPE "FeedbackStatus" ADD VALUE 'FIXED';
ALTER TYPE "FeedbackStatus" ADD VALUE 'ANSWERED';
