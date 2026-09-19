-- CreateEnum
CREATE TYPE "FormAccess" AS ENUM ('PUBLIC', 'CLASSROOM');

-- CreateEnum
CREATE TYPE "FormStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('DRAFT', 'PENDING_VERIFICATION', 'SUBMITTED');

-- CreateTable
CREATE TABLE "forms" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "access" "FormAccess" NOT NULL DEFAULT 'PUBLIC',
    "status" "FormStatus" NOT NULL DEFAULT 'DRAFT',
    "draft_fields" JSONB,
    "current_revision_id" TEXT,
    "response_cap" INTEGER,
    "closes_at" TIMESTAMP(3),
    "allow_multiple" BOOLEAN NOT NULL DEFAULT false,
    "save_partials" BOOLEAN NOT NULL DEFAULT false,
    "confirmation_email" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_revisions" (
    "id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_responses" (
    "id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "name" TEXT,
    "answers" JSONB NOT NULL,
    "resolved_context" JSONB,
    "submission_state" "SubmissionState" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verified_at" TIMESTAMP(3),
    "draft_token" TEXT,
    "staff_status" TEXT,
    "staff_note" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_magic_tokens" (
    "id" TEXT NOT NULL,
    "response_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_magic_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forms_classroom_id_idx" ON "forms"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "forms_classroom_id_slug_key" ON "forms"("classroom_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "form_revisions_form_id_version_key" ON "form_revisions"("form_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "form_responses_draft_token_key" ON "form_responses"("draft_token");

-- CreateIndex
CREATE INDEX "form_responses_form_id_submitted_at_idx" ON "form_responses"("form_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_magic_tokens_token_hash_key" ON "form_magic_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "form_magic_tokens_response_id_idx" ON "form_magic_tokens"("response_id");

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_revisions" ADD CONSTRAINT "form_revisions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "form_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_magic_tokens" ADD CONSTRAINT "form_magic_tokens_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "form_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Response identity uniqueness. PARTIAL indexes, so neither can be expressed in
-- the Prisma schema — this raw SQL is the only definition. `prisma migrate diff`
-- will not propose them; they must be carried by hand into any future migration
-- that rebuilds form_responses.
-- ---------------------------------------------------------------------------

-- Classroom fills: one response per signed-in user, per form. `allow_multiple`
-- means the filler may REPLACE this row until the form closes — never add a
-- second one.
CREATE UNIQUE INDEX "form_responses_form_user_unique"
  ON "form_responses" ("form_id", "user_id")
  WHERE "user_id" IS NOT NULL;

-- Public fills: one response per normalized email, among the anonymous rows
-- only. Scoped to user_id IS NULL so the two identity regimes never collide,
-- and so an unverified public row that expires after 48h frees exactly the slot
-- it was holding.
CREATE UNIQUE INDEX "form_responses_form_email_unique"
  ON "form_responses" ("form_id", "email_normalized")
  WHERE "user_id" IS NULL;
