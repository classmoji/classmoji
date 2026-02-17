-- CreateEnum
CREATE TYPE "GitProvider" AS ENUM ('GITHUB', 'GITLAB', 'BITBUCKET', 'GITEA');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'TEACHER', 'STUDENT', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "Term" AS ENUM ('FALL', 'SPRING', 'SUMMER', 'WINTER');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('INDIVIDUAL', 'GROUP');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuizStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QuizGradingStrategy" AS ENUM ('HIGHEST', 'MOST_RECENT', 'FIRST');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TokenTransactionType" AS ENUM ('GRANT', 'PURCHASE', 'REFUND', 'REMOVAL');

-- CreateEnum
CREATE TYPE "RegradeRequestStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "AuditLogAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'ACCESS_DENIED');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('SYLLABUS', 'RESOURCE', 'ASSIGNMENT');

-- CreateEnum
CREATE TYPE "AIConversationType" AS ENUM ('QUIZ', 'SYLLABUS_BOT', 'PROMPT_ASSISTANT');

-- CreateEnum
CREATE TYPE "AIConversationStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('OFFICE_HOURS', 'LECTURE', 'LAB', 'ASSESSMENT');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "id_token" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "provider" "GitProvider",
    "provider_id" TEXT,
    "login" TEXT,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "image" TEXT,
    "student_id" TEXT,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "stripe_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL DEFAULT 'FREE',
    "stripe_subscription_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_organizations" (
    "id" TEXT NOT NULL,
    "provider" "GitProvider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "base_url" TEXT,
    "github_installation_id" TEXT,
    "access_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classrooms" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "git_org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "term" "Term",
    "year" INTEGER,
    "emoji" TEXT NOT NULL DEFAULT 'dart',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classrooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_settings" (
    "classroom_id" TEXT NOT NULL,
    "default_tokens_per_hour" INTEGER NOT NULL DEFAULT 0,
    "late_penalty_points_per_hour" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "show_grades_to_students" BOOLEAN NOT NULL DEFAULT false,
    "quizzes_enabled" BOOLEAN NOT NULL DEFAULT true,
    "slides_enabled" BOOLEAN NOT NULL DEFAULT false,
    "syllabus_bot_enabled" BOOLEAN NOT NULL DEFAULT false,
    "syllabus_bot_model" TEXT,
    "llm_provider" TEXT,
    "llm_model" TEXT,
    "llm_temperature" DOUBLE PRECISION,
    "llm_max_tokens" INTEGER,
    "openai_api_key" TEXT,
    "anthropic_api_key" TEXT,
    "code_aware_model" TEXT,
    "content_repo_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_settings_pkey" PRIMARY KEY ("classroom_id")
);

-- CreateTable
CREATE TABLE "classroom_memberships" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "is_grader" BOOLEAN NOT NULL DEFAULT false,
    "has_accepted_invite" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT,
    "letter_grade" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modules" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "type" "AssignmentType" NOT NULL,
    "tag_id" TEXT,
    "is_extra_credit" BOOLEAN NOT NULL DEFAULT false,
    "drop_lowest_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "student_deadline" TIMESTAMP(3),
    "grader_deadline" TIMESTAMP(3),
    "tokens_per_hour" INTEGER NOT NULL DEFAULT 0,
    "branch" TEXT,
    "workflow_file" TEXT,
    "release_at" TIMESTAMP(3),
    "grades_released" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "provider" "GitProvider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "student_id" TEXT,
    "team_id" TEXT,
    "contributions" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_assignments" (
    "id" TEXT NOT NULL,
    "provider" "GitProvider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_issue_number" INTEGER NOT NULL,
    "repository_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMP(3),
    "is_late_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_assignment_graders" (
    "id" TEXT NOT NULL,
    "repository_assignment_id" TEXT NOT NULL,
    "grader_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_assignment_graders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_grades" (
    "id" TEXT NOT NULL,
    "repository_assignment_id" TEXT NOT NULL,
    "grader_id" TEXT,
    "emoji" TEXT NOT NULL,
    "token_transaction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regrade_requests" (
    "id" TEXT NOT NULL,
    "repository_assignment_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "student_comment" TEXT,
    "grader_comment" TEXT,
    "previous_grade" TEXT[],
    "status" "RegradeRequestStatus" NOT NULL DEFAULT 'IN_REVIEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regrade_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emoji_mappings" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "grade" DOUBLE PRECISION NOT NULL,
    "extra_tokens" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emoji_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_grade_mappings" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "letter_grade" TEXT NOT NULL,
    "min_grade" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_grade_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "provider" "GitProvider",
    "provider_id" TEXT,
    "classroom_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_visible" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_tags" (
    "id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_transactions" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "repository_assignment_id" TEXT,
    "amount" INTEGER NOT NULL,
    "type" "TokenTransactionType" NOT NULL,
    "hours_purchased" INTEGER,
    "balance_after" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "action" "AuditLogAction" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quizzes" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "module_id" TEXT,
    "name" TEXT NOT NULL,
    "system_prompt" TEXT,
    "rubric_prompt" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "status" "QuizStatus" NOT NULL DEFAULT 'DRAFT',
    "weight" INTEGER NOT NULL DEFAULT 0,
    "question_count" INTEGER NOT NULL DEFAULT 5,
    "difficulty_level" TEXT,
    "subject" TEXT,
    "include_code_context" BOOLEAN NOT NULL DEFAULT false,
    "grading_strategy" "QuizGradingStrategy" NOT NULL DEFAULT 'HIGHEST',
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_attempts" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "feedback" TEXT,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "questions_asked" INTEGER NOT NULL DEFAULT 0,
    "session_token" TEXT,
    "last_activity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_duration_ms" INTEGER,
    "unfocused_duration_ms" INTEGER,
    "modal_closed_at" TIMESTAMP(3),
    "question_results" JSONB,
    "correct_percentage" DOUBLE PRECISION,
    "partial_percentage" DOUBLE PRECISION,
    "incorrect_percentage" DOUBLE PRECISION,
    "codebase_path" TEXT,
    "agent_config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slides" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "content_path" TEXT NOT NULL,
    "multiplex_id" TEXT,
    "multiplex_secret" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "module_id" TEXT,
    "type" "PageType" NOT NULL,
    "title" TEXT NOT NULL,
    "content_path" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 2,
    "show_in_student_menu" BOOLEAN NOT NULL DEFAULT false,
    "menu_order" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "event_type" "EventType" NOT NULL DEFAULT 'LECTURE',
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "meeting_link" TEXT,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_rule" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_overrides" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "new_start_time" TIMESTAMP(3),
    "new_end_time" TIMESTAMP(3),
    "new_location" TEXT,
    "new_meeting_link" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "type" "AIConversationType" NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "context" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "last_activity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AIConversationStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "users_provider_login_idx" ON "users"("provider", "login");

-- CreateIndex
CREATE UNIQUE INDEX "users_provider_provider_id_key" ON "users"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "git_organizations_provider_login_idx" ON "git_organizations"("provider", "login");

-- CreateIndex
CREATE UNIQUE INDEX "git_organizations_provider_provider_id_key" ON "git_organizations"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_slug_key" ON "classrooms"("slug");

-- CreateIndex
CREATE INDEX "classrooms_git_org_id_idx" ON "classrooms"("git_org_id");

-- CreateIndex
CREATE INDEX "classroom_memberships_user_id_idx" ON "classroom_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_memberships_classroom_id_user_id_key" ON "classroom_memberships"("classroom_id", "user_id");

-- CreateIndex
CREATE INDEX "modules_classroom_id_idx" ON "modules"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "modules_classroom_id_title_key" ON "modules"("classroom_id", "title");

-- CreateIndex
CREATE INDEX "assignments_module_id_idx" ON "assignments"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_module_id_title_key" ON "assignments"("module_id", "title");

-- CreateIndex
CREATE INDEX "repositories_classroom_id_idx" ON "repositories"("classroom_id");

-- CreateIndex
CREATE INDEX "repositories_module_id_idx" ON "repositories"("module_id");

-- CreateIndex
CREATE INDEX "repositories_student_id_idx" ON "repositories"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_provider_provider_id_key" ON "repositories"("provider", "provider_id");

-- CreateIndex
CREATE INDEX "repository_assignments_repository_id_idx" ON "repository_assignments"("repository_id");

-- CreateIndex
CREATE INDEX "repository_assignments_assignment_id_idx" ON "repository_assignments"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "repository_assignments_provider_provider_id_key" ON "repository_assignments"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "repository_assignment_graders_repository_assignment_id_grad_key" ON "repository_assignment_graders"("repository_assignment_id", "grader_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_grades_token_transaction_id_key" ON "assignment_grades"("token_transaction_id");

-- CreateIndex
CREATE INDEX "regrade_requests_classroom_id_idx" ON "regrade_requests"("classroom_id");

-- CreateIndex
CREATE INDEX "regrade_requests_student_id_idx" ON "regrade_requests"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "emoji_mappings_classroom_id_emoji_key" ON "emoji_mappings"("classroom_id", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "letter_grade_mappings_classroom_id_letter_grade_key" ON "letter_grade_mappings"("classroom_id", "letter_grade");

-- CreateIndex
CREATE UNIQUE INDEX "teams_classroom_id_slug_key" ON "teams"("classroom_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "teams_provider_provider_id_key" ON "teams"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_memberships_team_id_user_id_key" ON "team_memberships"("team_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_classroom_id_name_key" ON "tags"("classroom_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_tags_tag_id_team_id_key" ON "team_tags"("tag_id", "team_id");

-- CreateIndex
CREATE INDEX "token_transactions_classroom_id_idx" ON "token_transactions"("classroom_id");

-- CreateIndex
CREATE INDEX "token_transactions_student_id_idx" ON "token_transactions"("student_id");

-- CreateIndex
CREATE INDEX "audit_logs_classroom_id_idx" ON "audit_logs"("classroom_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "quizzes_classroom_id_idx" ON "quizzes"("classroom_id");

-- CreateIndex
CREATE INDEX "quizzes_module_id_idx" ON "quizzes"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_attempts_conversation_id_key" ON "quiz_attempts"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_attempts_session_token_key" ON "quiz_attempts"("session_token");

-- CreateIndex
CREATE INDEX "quiz_attempts_quiz_id_idx" ON "quiz_attempts"("quiz_id");

-- CreateIndex
CREATE INDEX "quiz_attempts_user_id_idx" ON "quiz_attempts"("user_id");

-- CreateIndex
CREATE INDEX "slides_classroom_id_idx" ON "slides"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "slides_classroom_id_module_slug_key" ON "slides"("classroom_id", "module", "slug");

-- CreateIndex
CREATE INDEX "pages_classroom_id_idx" ON "pages"("classroom_id");

-- CreateIndex
CREATE INDEX "pages_module_id_idx" ON "pages"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "pages_classroom_id_title_key" ON "pages"("classroom_id", "title");

-- CreateIndex
CREATE INDEX "calendar_events_classroom_id_idx" ON "calendar_events"("classroom_id");

-- CreateIndex
CREATE INDEX "calendar_events_start_time_idx" ON "calendar_events"("start_time");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_overrides_event_id_date_key" ON "calendar_event_overrides"("event_id", "date");

-- CreateIndex
CREATE INDEX "ai_conversations_classroom_id_idx" ON "ai_conversations"("classroom_id");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_idx" ON "ai_conversations"("user_id");

-- CreateIndex
CREATE INDEX "ai_conversations_type_idx" ON "ai_conversations"("type");

-- CreateIndex
CREATE INDEX "ai_conversation_messages_conversation_id_idx" ON "ai_conversation_messages"("conversation_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_git_org_id_fkey" FOREIGN KEY ("git_org_id") REFERENCES "git_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_settings" ADD CONSTRAINT "classroom_settings_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modules" ADD CONSTRAINT "modules_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modules" ADD CONSTRAINT "modules_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_assignments" ADD CONSTRAINT "repository_assignments_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_assignments" ADD CONSTRAINT "repository_assignments_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_assignment_graders" ADD CONSTRAINT "repository_assignment_graders_repository_assignment_id_fkey" FOREIGN KEY ("repository_assignment_id") REFERENCES "repository_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_assignment_graders" ADD CONSTRAINT "repository_assignment_graders_grader_id_fkey" FOREIGN KEY ("grader_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_grades" ADD CONSTRAINT "assignment_grades_repository_assignment_id_fkey" FOREIGN KEY ("repository_assignment_id") REFERENCES "repository_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_grades" ADD CONSTRAINT "assignment_grades_grader_id_fkey" FOREIGN KEY ("grader_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_grades" ADD CONSTRAINT "assignment_grades_token_transaction_id_fkey" FOREIGN KEY ("token_transaction_id") REFERENCES "token_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_repository_assignment_id_fkey" FOREIGN KEY ("repository_assignment_id") REFERENCES "repository_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emoji_mappings" ADD CONSTRAINT "emoji_mappings_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter_grade_mappings" ADD CONSTRAINT "letter_grade_mappings_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_tags" ADD CONSTRAINT "team_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_repository_assignment_id_fkey" FOREIGN KEY ("repository_assignment_id") REFERENCES "repository_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slides" ADD CONSTRAINT "slides_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slides" ADD CONSTRAINT "slides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_overrides" ADD CONSTRAINT "calendar_event_overrides_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation_messages" ADD CONSTRAINT "ai_conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
