-- Quiz extensions: a token transaction can name the QUIZ assignment its hours
-- were bought on. Additive, no backfill: existing rows keep assignment_id NULL.
ALTER TABLE "token_transactions" ADD COLUMN "assignment_id" TEXT;

-- Hours bought per (assignment, student) are summed on every grade read.
CREATE INDEX "token_transactions_assignment_id_student_id_idx" ON "token_transactions"("assignment_id", "student_id");

-- SET NULL, not CASCADE: the balance is read from the latest row's
-- balance_after, so deleting ledger rows with an assignment would rewind it.
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A row extends at most one thing: a repo submission or a quiz assignment.
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_one_target" CHECK (
  num_nonnulls("git_repo_assignment_id", "assignment_id") <= 1
);
