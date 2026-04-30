-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('QUIZ_PUBLISHED', 'PAGE_PUBLISHED', 'PAGE_UNPUBLISHED', 'MODULE_PUBLISHED', 'MODULE_UNPUBLISHED', 'ASSIGNMENT_DUE_DATE_CHANGED', 'ASSIGNMENT_GRADED', 'TA_GRADING_ASSIGNED', 'TA_REGRADE_ASSIGNED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "classroom_id" TEXT,
    "type" "NotificationType" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metadata" JSONB,
    "read_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" TEXT NOT NULL,
    "email_quiz_published" BOOLEAN NOT NULL DEFAULT true,
    "email_page_published" BOOLEAN NOT NULL DEFAULT false,
    "email_page_unpublished" BOOLEAN NOT NULL DEFAULT false,
    "email_module_published" BOOLEAN NOT NULL DEFAULT true,
    "email_module_unpublished" BOOLEAN NOT NULL DEFAULT false,
    "email_assignment_due_date_changed" BOOLEAN NOT NULL DEFAULT true,
    "email_assignment_graded" BOOLEAN NOT NULL DEFAULT true,
    "email_ta_grading_assigned" BOOLEAN NOT NULL DEFAULT true,
    "email_ta_regrade_assigned" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_expires_at_idx" ON "notifications"("expires_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
