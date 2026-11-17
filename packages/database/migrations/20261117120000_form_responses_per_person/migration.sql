-- How many responses one person may give a CLASSROOM form: ONE (the default),
-- REPLACE (one, which they may overwrite until close: what `allow_multiple`
-- meant), or MANY (each submit is a separate response).
--
-- `forms.allow_multiple` is NOT dropped here. The pages and MCP apps redeploy a
-- few minutes after this release command runs, and until then their old code
-- still reads that column (raw SQL in `lockForm`, Prisma selects). The
-- follow-up migration one deploy later drops it; nothing reads it after this
-- deploy.

BEGIN;

-- First, so no lock this file takes waits unbounded on the previous build,
-- which keeps serving while this runs. A lock that cannot be had within it
-- fails the file, and the deploy, with nothing written.
SET LOCAL lock_timeout = '5s';

CREATE TYPE "FormResponsesPerPerson" AS ENUM ('ONE', 'REPLACE', 'MANY');

ALTER TABLE "forms"
  ADD COLUMN "responses_per_person" "FormResponsesPerPerson" NOT NULL DEFAULT 'ONE';

UPDATE "forms" SET "responses_per_person" = 'REPLACE' WHERE "allow_multiple";

-- Copied from the form's mode when the row is written (true only on a MANY
-- form), because a partial index cannot look at another table.
ALTER TABLE "form_responses" ADD COLUMN "repeatable" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Classroom identity uniqueness, rebuilt per row kind. PARTIAL indexes, so
-- neither can be expressed in the Prisma schema: this raw SQL is the only
-- definition, and it must be carried by hand into any future migration that
-- rebuilds form_responses. The PUBLIC email index is unchanged.
-- ---------------------------------------------------------------------------

DROP INDEX "form_responses_form_user_unique";

-- ONE and REPLACE forms: one row per signed-in user, per form, as before.
CREATE UNIQUE INDEX "form_responses_form_user_unique"
  ON "form_responses" ("form_id", "user_id")
  WHERE "user_id" IS NOT NULL AND NOT "repeatable";

-- MANY forms: any number of SUBMITTED rows per user, but at most one DRAFT,
-- the row autosave writes to and the next submit turns into a response.
CREATE UNIQUE INDEX "form_responses_form_user_draft_unique"
  ON "form_responses" ("form_id", "user_id")
  WHERE "user_id" IS NOT NULL AND "repeatable" AND "submission_state" = 'DRAFT';

-- The plain lookup the two above cannot serve: their predicates name
-- `repeatable`, so a query for one person's rows on a form (`form_id` and
-- `user_id` only, as the fill page and `submitClassroom` ask, the latter
-- while holding the form row lock) would otherwise scan the form's rows.
CREATE INDEX "form_responses_form_id_user_id_idx"
  ON "form_responses" ("form_id", "user_id");

COMMIT;
