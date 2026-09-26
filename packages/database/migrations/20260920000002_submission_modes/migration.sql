-- ============================================================================
-- Coursework model, phase 3: two submission modes for a REPO assignment.
--
-- ISSUE (existing): Classmoji opens one GitHub issue per student repo and
-- closing it submits. REPO (new): no issue; a push to the student repo's
-- default branch submits. Both grade on the same git_repo_assignments row, so
-- that row no longer requires an issue.
--
-- Repositories that have no assignments at all (professors who never used
-- issues) each get one REPO-mode assignment named after the repository, in
-- the module a legacy REPOSITORY module item points at or a synthesized one,
-- plus one submission row per existing student repo. That is what makes those
-- repositories reachable in Modules and gradable.
--
-- Prisma runs the whole file in one transaction.
-- ============================================================================

-- 1. The mode.
CREATE TYPE "SubmissionMode" AS ENUM ('ISSUE', 'REPO');
ALTER TABLE "assignments"
  ADD COLUMN "submission_mode" "SubmissionMode" NOT NULL DEFAULT 'ISSUE';

-- 2. A submission row no longer needs an issue.
ALTER TABLE "git_repo_assignments"
  ALTER COLUMN "provider_id" DROP NOT NULL,
  ALTER COLUMN "provider_issue_number" DROP NOT NULL;

-- 3. The natural key both modes share. Report and drop any duplicate first
--    (none are expected: every writer guards on this pair), keeping the row
--    with grades, else the oldest.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'duplicate_submission_row', gr."classroom_id", ra."id",
       jsonb_build_object('git_repo_id', ra."git_repo_id",
                          'assignment_id', ra."assignment_id",
                          'provider_issue_number', ra."provider_issue_number")
FROM "git_repo_assignments" ra
JOIN "git_repos" gr ON gr."id" = ra."git_repo_id"
WHERE ra."id" NOT IN (
  SELECT DISTINCT ON (r."git_repo_id", r."assignment_id") r."id"
  FROM "git_repo_assignments" r
  LEFT JOIN "assignment_grades" g ON g."git_repo_assignment_id" = r."id"
  GROUP BY r."id", r."git_repo_id", r."assignment_id", r."created_at"
  ORDER BY r."git_repo_id", r."assignment_id", count(g."id") DESC, r."created_at" ASC, r."id" ASC
);

DELETE FROM "git_repo_assignments"
WHERE "id" IN (SELECT "subject_id" FROM "coursework_migration_report" WHERE "kind" = 'duplicate_submission_row');

CREATE UNIQUE INDEX "git_repo_assignments_git_repo_id_assignment_id_key"
  ON "git_repo_assignments"("git_repo_id", "assignment_id");

-- 4. Repositories with no assignments become one REPO-mode assignment each.
--    Module: the canonical legacy REPOSITORY module item (lowest module
--    position), else a synthesized module named after the repository, exactly
--    as the phase 1 migration did for repositories that had issues.
DO $$
DECLARE
  r RECORD;
  target_module_id TEXT;
  candidate TEXT;
  n INT;
  next_pos INT;
  new_assignment_id TEXT;
  rows_created INT;
BEGIN
  FOR r IN
    SELECT rp."id", rp."classroom_id", rp."title", rp."is_published", rp."created_at"
    FROM "repositories" rp
    WHERE NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."repository_id" = rp."id")
    ORDER BY rp."classroom_id", rp."created_at", rp."id"
  LOOP
    SELECT mi."module_id" INTO target_module_id
    FROM "module_items" mi
    JOIN "modules" m ON m."id" = mi."module_id"
    WHERE mi."repository_id" = r."id" AND m."classroom_id" = r."classroom_id"
    ORDER BY m."position" ASC, m."created_at" ASC, m."id" ASC
    LIMIT 1;

    IF target_module_id IS NULL THEN
      candidate := r."title";
      n := 1;
      WHILE EXISTS (SELECT 1 FROM "modules" m
                    WHERE m."classroom_id" = r."classroom_id" AND m."title" = candidate) LOOP
        n := n + 1;
        candidate := r."title" || ' (' || n || ')';
      END LOOP;

      SELECT coalesce(max("position"), -1) + 1 INTO next_pos
      FROM "modules" WHERE "classroom_id" = r."classroom_id";

      target_module_id := gen_random_uuid()::text;
      INSERT INTO "modules" ("id", "classroom_id", "title", "slug", "position",
                             "is_published", "is_public", "created_at", "updated_at")
      VALUES (target_module_id, r."classroom_id", candidate,
              trim(both '-' from regexp_replace(regexp_replace(
                regexp_replace(lower(candidate), '[^a-z0-9 -]', '', 'g'), ' +', '-', 'g'), '-+', '-', 'g')),
              next_pos, r."is_published", false, now(), now());
    END IF;

    new_assignment_id := gen_random_uuid()::text;
    INSERT INTO "assignments" ("id", "module_id", "type", "submission_mode", "repository_id",
                               "title", "slug", "weight", "is_extra_credit", "is_published",
                               "description", "tokens_per_hour", "release_at", "grades_released",
                               "created_at", "updated_at")
    VALUES (new_assignment_id, target_module_id, 'REPO', 'REPO', r."id",
            r."title",
            trim(both '-' from regexp_replace(regexp_replace(
              regexp_replace(lower(r."title"), '[^a-z0-9 -]', '', 'g'), ' +', '-', 'g'), '-+', '-', 'g')),
            100, false, r."is_published", '', 0, r."created_at", false, now(), now());

    -- One submission row per student repo that already exists. They start
    -- OPEN (never pushed as far as Classmoji knows); the post-migration
    -- backfill script fills closed_at from the repo's latest commit.
    INSERT INTO "git_repo_assignments" ("id", "provider", "git_repo_id", "assignment_id",
                                        "status", "is_late_override", "created_at", "updated_at")
    SELECT gen_random_uuid()::text, gr."provider", gr."id", new_assignment_id,
           'OPEN', false, now(), now()
    FROM "git_repos" gr WHERE gr."repository_id" = r."id";
    GET DIAGNOSTICS rows_created = ROW_COUNT;

    INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
    VALUES (gen_random_uuid()::text, 'repo_assignment_synthesized', r."classroom_id", r."id",
            jsonb_build_object('assignment_id', new_assignment_id,
                               'module_id', target_module_id,
                               'submission_rows', rows_created));

    target_module_id := NULL;
  END LOOP;
END $$;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'summary_phase3', NULL, NULL, jsonb_build_object(
  'duplicate_submission_rows_removed', (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'duplicate_submission_row'),
  'repo_assignments_synthesized',      (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'repo_assignment_synthesized'),
  'submission_rows_synthesized',       (SELECT coalesce(sum(("details"->>'submission_rows')::int), 0) FROM "coursework_migration_report" WHERE "kind" = 'repo_assignment_synthesized'));
