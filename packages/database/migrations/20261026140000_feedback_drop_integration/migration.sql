-- Integration requests are feature requests: fold them in, then drop the value.
UPDATE "feedback_posts" SET "category" = 'FEATURE' WHERE "category" = 'INTEGRATION';

-- AlterEnum
BEGIN;
CREATE TYPE "FeedbackCategory_new" AS ENUM ('FEATURE', 'BUG');
ALTER TABLE "feedback_posts" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "feedback_posts" ALTER COLUMN "category" TYPE "FeedbackCategory_new" USING ("category"::text::"FeedbackCategory_new");
ALTER TYPE "FeedbackCategory" RENAME TO "FeedbackCategory_old";
ALTER TYPE "FeedbackCategory_new" RENAME TO "FeedbackCategory";
DROP TYPE "FeedbackCategory_old";
ALTER TABLE "feedback_posts" ALTER COLUMN "category" SET DEFAULT 'FEATURE';
COMMIT;
