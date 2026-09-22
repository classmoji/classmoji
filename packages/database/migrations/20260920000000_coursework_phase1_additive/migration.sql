-- ============================================================================
-- Coursework model, phase 1 of 2: ADDITIVE + BACKFILL.
--
-- Module becomes the root unit of coursework. Every Assignment belongs to a
-- Module and has a kind (assignments.type = REPO | QUIZ | FORM). A Repository
-- has no module of its own: it is storage that a REPO assignment points at,
-- so one repository can serve assignments in several modules. Grading weight
-- moves off Repository onto Assignment, flattened so that every student's
-- course grade is unchanged (see step 5). Drop-lowest is removed.
--
-- This migration leaves the old repository columns in place, so the previous
-- app version keeps running against the result. The companion migration
-- (…_coursework_phase1_constraints) adds NOT NULL / CHECK and drops them.
--
-- Prisma runs the whole file in one transaction. A type created with CREATE
-- TYPE inside the transaction is usable right away (unlike ALTER TYPE … ADD
-- VALUE), which is what lets the enum rename, the new enum and the backfill
-- share a transaction. Every FK is added at the end so a bad backfill fails
-- the transaction instead of landing.
-- ============================================================================

-- 0. Ledger (modelled as CourseworkMigrationReport in schema.prisma).
CREATE TABLE "coursework_migration_report" (
  "id"           TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "classroom_id" TEXT,
  "subject_id"   TEXT,
  "details"      JSONB,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coursework_migration_report_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "coursework_migration_report_kind_idx" ON "coursework_migration_report"("kind");

-- 0b. Backups of everything this phase rewrites or drops (rollback source).
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'backup_repository', r."classroom_id", r."id",
       jsonb_build_object('weight', r."weight",
                          'is_extra_credit', r."is_extra_credit",
                          'drop_lowest_count', r."drop_lowest_count")
FROM "repositories" r;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'backup_assignment', r."classroom_id", a."id",
       jsonb_build_object('weight', a."weight", 'repository_id', a."repository_id")
FROM "assignments" a
JOIN "repositories" r ON r."id" = a."repository_id";

-- 1. Enum rename (metadata only; repositories.type keeps its OID and values),
--    then the freed name becomes the assignment-kind enum.
ALTER TYPE "AssignmentType" RENAME TO "RepositoryType";
CREATE TYPE "AssignmentType" AS ENUM ('REPO', 'QUIZ', 'FORM');

-- 2. New columns, nullable / defaulted for now.
ALTER TABLE "assignments"
  ADD COLUMN "module_id"       TEXT,
  ADD COLUMN "type"            "AssignmentType" NOT NULL DEFAULT 'REPO',
  ADD COLUMN "quiz_id"         TEXT,
  ADD COLUMN "form_id"         TEXT,
  ADD COLUMN "is_extra_credit" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "repository_id" DROP NOT NULL;

-- Int -> double precision. Existing integer values are exact as doubles.
ALTER TABLE "assignments"
  ALTER COLUMN "weight" TYPE DOUBLE PRECISION USING "weight"::double precision,
  ALTER COLUMN "weight" SET DEFAULT 100;

-- 3. Which module each repository's existing assignments move into. The
--    mapping lives only for this transaction: a repository that sits in
--    several modules (legacy REPOSITORY module_items) hands its assignments
--    to the canonical one = lowest (position, created_at, id). The legacy
--    module_items rows are left as they are; the UI no longer reads them.
CREATE TEMP TABLE "repo_module" (
  "repository_id" TEXT PRIMARY KEY,
  "module_id"     TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO "repo_module" ("repository_id", "module_id")
SELECT DISTINCT ON (mi."repository_id") mi."repository_id", mi."module_id"
FROM "module_items" mi
JOIN "modules" m ON m."id" = mi."module_id"
WHERE mi."repository_id" IS NOT NULL
ORDER BY mi."repository_id", m."position" ASC, m."created_at" ASC, m."id" ASC;

-- 3b. Report the repositories that sat in more than one module, so the owner
--     knows where their assignments went.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'repository_in_multiple_modules', m."classroom_id", mi."repository_id",
       jsonb_build_object('module_item_id', mi."id",
                          'module_id', mi."module_id",
                          'module_title', m."title",
                          'position', mi."position",
                          'canonical_module_id', rm."module_id")
FROM "module_items" mi
JOIN "modules" m ON m."id" = mi."module_id"
JOIN "repo_module" rm ON rm."repository_id" = mi."repository_id"
WHERE mi."repository_id" IS NOT NULL AND mi."module_id" <> rm."module_id";

-- 4. Repositories with assignments but no module: one synthesized module
--    each, titled after the repository (" (n)" suffix on collision), appended
--    to the classroom's module order, is_published mirrored, slug derived the
--    way titleToIdentifier() does it. A repository with no assignments needs
--    no module; it stays reachable on the Repositories page.
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
  next_pos INT;
  new_module_id TEXT;
BEGIN
  FOR r IN
    SELECT rp."id", rp."classroom_id", rp."title", rp."is_published"
    FROM "repositories" rp
    WHERE NOT EXISTS (SELECT 1 FROM "repo_module" rm WHERE rm."repository_id" = rp."id")
      AND EXISTS (SELECT 1 FROM "assignments" a WHERE a."repository_id" = rp."id")
    ORDER BY rp."classroom_id", rp."created_at", rp."id"
  LOOP
    candidate := r."title";
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "modules" m
                  WHERE m."classroom_id" = r."classroom_id" AND m."title" = candidate) LOOP
      n := n + 1;
      candidate := r."title" || ' (' || n || ')';
    END LOOP;

    SELECT coalesce(max("position"), -1) + 1 INTO next_pos
    FROM "modules" WHERE "classroom_id" = r."classroom_id";

    new_module_id := gen_random_uuid()::text;

    INSERT INTO "modules" ("id", "classroom_id", "title", "slug", "position",
                           "is_published", "is_public", "created_at", "updated_at")
    VALUES (new_module_id, r."classroom_id", candidate,
            trim(both '-' from regexp_replace(regexp_replace(
              regexp_replace(lower(candidate), '[^a-z0-9 -]', '', 'g'), ' +', '-', 'g'), '-+', '-', 'g')),
            next_pos, r."is_published", false, now(), now());

    INSERT INTO "repo_module" ("repository_id", "module_id") VALUES (r."id", new_module_id);

    INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
    VALUES (gen_random_uuid()::text, 'orphan_module_synthesized', r."classroom_id", r."id",
            jsonb_build_object('module_id', new_module_id,
                               'module_title', candidate,
                               'position', next_pos));
  END LOOP;
END $$;

-- 5. Flatten weights, copy the extra-credit flag, set module_id on assignments.
--
--    Old course grade = Σ_r W_r · G_r / Σ_r W_r, with G_r = Σ_a w_a·g_a / Σ_a w_a
--    inside a non-extra-credit repository. Giving each assignment
--        new_w(a) = W_r · w_a / Σ_{a' in r} w_a'
--    makes the flat Σ_a new_w·g / Σ_a new_w reproduce it exactly.
--    Extra-credit repositories were never normalised (the old engine used
--    Σ w·g/100), so their divisor is 100. A repository whose assignment
--    weights sum to 0 was skipped by the old engine; zero new weights make
--    the new engine skip it too.
--
--    The SET expressions read the pre-update a.weight and the subquery is a
--    statement snapshot, so Σ is computed over the OLD weights.
UPDATE "assignments" a
SET "weight" = CASE
                 WHEN r."is_extra_credit" THEN r."weight"::double precision * a."weight" / 100.0
                 WHEN s."sum_w" = 0        THEN 0
                 ELSE r."weight"::double precision * a."weight" / s."sum_w"
               END,
    "is_extra_credit" = r."is_extra_credit",
    "module_id"       = rm."module_id",
    "type"            = 'REPO'
FROM "repositories" r,
     "repo_module" rm,
     (SELECT "repository_id", sum("weight")::double precision AS "sum_w"
      FROM "assignments" GROUP BY "repository_id") s
WHERE a."repository_id" = r."id"
  AND rm."repository_id" = r."id"
  AND s."repository_id" = a."repository_id";

-- 5b. Every assignment must have found a module by now. Fail loudly here
--     rather than at the NOT NULL in the companion migration.
DO $$
DECLARE missing INT;
BEGIN
  SELECT count(*) INTO missing FROM "assignments" WHERE "module_id" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'coursework phase 1: % assignment(s) have no module after backfill', missing;
  END IF;
END $$;

-- 6. Reports for the owner.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'drop_lowest_lost', r."classroom_id", r."id",
       jsonb_build_object('repository_title', r."title",
                          'drop_lowest_count', r."drop_lowest_count",
                          'classroom_slug', c."slug")
FROM "repositories" r
JOIN "classrooms" c ON c."id" = r."classroom_id"
WHERE r."drop_lowest_count" > 0;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'zero_weight_sum_repository', r."classroom_id", r."id",
       jsonb_build_object('repository_title', r."title", 'repository_weight', r."weight")
FROM "repositories" r
WHERE EXISTS (SELECT 1 FROM "assignments" a WHERE a."repository_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "coursework_migration_report" b
                  WHERE b."kind" = 'backup_assignment'
                    AND (b."details"->>'repository_id') = r."id"
                    AND (b."details"->>'weight')::double precision <> 0);

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'assignment_title_collision_in_module', m."classroom_id", a."module_id",
       jsonb_build_object('title', a."title", 'count', count(*))
FROM "assignments" a
JOIN "modules" m ON m."id" = a."module_id"
GROUP BY m."classroom_id", a."module_id", a."title"
HAVING count(*) > 1;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'summary', NULL, NULL, jsonb_build_object(
  'repositories',                (SELECT count(*) FROM "repositories"),
  'orphans_synthesized',         (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'orphan_module_synthesized'),
  'repositories_in_multiple_modules', (SELECT count(DISTINCT "subject_id") FROM "coursework_migration_report" WHERE "kind" = 'repository_in_multiple_modules'),
  'drop_lowest_classrooms',      (SELECT count(DISTINCT "classroom_id") FROM "coursework_migration_report" WHERE "kind" = 'drop_lowest_lost'),
  'drop_lowest_repositories',    (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'drop_lowest_lost'),
  'zero_weight_sum_repositories',(SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'zero_weight_sum_repository'),
  'assignment_title_collisions', (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'assignment_title_collision_in_module'),
  'extra_credit_assignments',    (SELECT count(*) FROM "assignments" WHERE "is_extra_credit"),
  'assignments_now_zero_weight', (SELECT count(*) FROM "assignments" WHERE "weight" = 0));

-- 7. Indexes + FKs, named as Prisma names them. Adding the FKs here validates
--    the backfill inside this transaction.
CREATE INDEX "assignments_module_id_idx"  ON "assignments"("module_id");
CREATE UNIQUE INDEX "assignments_quiz_id_key" ON "assignments"("quiz_id");
CREATE UNIQUE INDEX "assignments_form_id_key" ON "assignments"("form_id");

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_module_id_fkey"
  FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_quiz_id_fkey"
  FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_form_id_fkey"
  FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
