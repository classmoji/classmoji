-- Who typed this response in, when it was not the respondent.
--
-- Every row in form_responses got there because a person filled the form in.
-- `createResponses` adds a staff-side path, and without a column saying so a
-- row staff typed is indistinguishable from one somebody submitted: it is
-- SUBMITTED, it carries a verified_at, and it points at a revision documented
-- as "what the person actually saw". All three are set on purpose — the cap
-- counts exactly those rows, and a staff-added person has to count — so none of
-- them is available to carry the distinction.
--
-- NULL means the respondent submitted it themselves, which is true of every row
-- that already exists, so there is no backfill and nothing to repair.
--
-- SET NULL rather than CASCADE on delete: a staff account leaving the platform
-- must not take the responses they entered with it. The row survives; only the
-- attribution is lost, which is the same trade user_id already makes.
ALTER TABLE "form_responses" ADD COLUMN "added_by" TEXT;

-- CreateIndex
CREATE INDEX "form_responses_added_by_idx" ON "form_responses"("added_by");

-- AddForeignKey
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
