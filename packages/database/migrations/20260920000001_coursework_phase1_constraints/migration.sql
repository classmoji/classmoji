-- ============================================================================
-- Coursework model, phase 2 of 2: CONSTRAINTS + DROPS.
--
-- Destructive. Only reached once the additive migration succeeded (its FKs
-- validated the backfill) and the coursework_migration_report ledger has
-- been reviewed. After this the previous app version no longer runs.
-- ============================================================================

ALTER TABLE "repositories" ALTER COLUMN "module_id" SET NOT NULL;
ALTER TABLE "assignments"  ALTER COLUMN "module_id" SET NOT NULL;

-- Callers must say what kind of assignment they are creating.
ALTER TABLE "assignments" ALTER COLUMN "type" DROP DEFAULT;

-- Exactly one target, and it matches the kind.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_type_target" CHECK (
  ("type" = 'REPO' AND "repository_id" IS NOT NULL AND "quiz_id" IS NULL AND "form_id" IS NULL) OR
  ("type" = 'QUIZ' AND "quiz_id" IS NOT NULL AND "repository_id" IS NULL AND "form_id" IS NULL) OR
  ("type" = 'FORM' AND "form_id" IS NOT NULL AND "repository_id" IS NULL AND "quiz_id" IS NULL)
);

-- Grading weight now lives on assignments only; drop-lowest is gone.
ALTER TABLE "repositories"
  DROP COLUMN "weight",
  DROP COLUMN "is_extra_credit",
  DROP COLUMN "drop_lowest_count";
