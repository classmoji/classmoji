-- ============================================================================
-- Quizzes as assignments, phase 2: EXPAND + BACKFILL.
--
-- A quiz's due date, publish state and weight move onto its QUIZ Assignment,
-- which also gains a close date (`closes_at`: from then on no new attempt can
-- start; empty = never closes). The quiz columns (`due_date`, `status`,
-- `weight`) stay and are written as a mirror by the new code, so services
-- still on the previous build keep reading consistent values. Nothing is
-- dropped here.
--
-- The backfill is generic: it names no classroom, quiz or module.
--   0. Backups: one `backup_quiz` ledger row per quiz.
--   1. A quiz that already has an assignment: the assignment takes the quiz's
--      name, weight and publish state, and the quiz's due date where the
--      assignment has none. Reported where the title, weight, publish state
--      or due date changes, and where a published quiz's assignment opens in
--      the future (students do not see it until then).
--   2. A quiz with no assignment but with QUIZ module items: one QUIZ
--      assignment in the item's module (when several: a published module
--      first, then the lowest module position).
--   3. A quiz in no module: untouched (reported).
--   4. A CLOSED quiz's assignment closes at the quiz's last update.
--   5. Mirror: every assigned quiz's due_date := its assignment's deadline.
--   6. One weight summary row per classroom with quiz assignments.
--   7. Guard: RAISE EXCEPTION on any mismatch, which aborts the whole file.
--
-- Prisma runs the file in one transaction. A failed guard, or a lock not had
-- within the lock timeout below, leaves nothing behind but a failed row in
-- `_prisma_migrations`, which stops later deploys: recover with
-- `prisma migrate resolve --rolled-back 20261002120000_quiz_assignments`
-- (and a fixed file, for a guard failure), then redeploy. A passing but wrong
-- run is undone from the ledger (`backup_quiz`, `quiz_assignment_created`).
-- ============================================================================

-- First, so no lock this file takes (the ALTER's included) waits unbounded on
-- the previous build, which keeps serving while this runs. A lock that cannot
-- be had within it fails the file, and the deploy, with nothing written.
SET LOCAL lock_timeout = '10s';

ALTER TABLE "assignments" ADD COLUMN "closes_at" TIMESTAMP(3);

-- Writes to quizzes and module items wait until this commits, so none lands
-- between the backfill and the guard (a quiz or QUIZ item added there would
-- fail the guard). Reads go on.
LOCK TABLE "quizzes", "module_items" IN SHARE MODE;

-- ==== BACKFILL ====

-- 0. Backups of every quiz and the assignment it had.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'backup_quiz', q."classroom_id", q."id",
       jsonb_build_object(
         'name', q."name",
         'status', q."status",
         'due_date', q."due_date",
         'weight', q."weight",
         'assignment', CASE WHEN a."id" IS NULL THEN NULL ELSE jsonb_build_object(
           'id', a."id",
           'title', a."title",
           'module_id', a."module_id",
           'weight', a."weight",
           'is_published', a."is_published",
           'student_deadline', a."student_deadline") END)
FROM "quizzes" q
LEFT JOIN "assignments" a ON a."quiz_id" = q."id";

-- 1. Quizzes that already have an assignment. Reports first (they read the
--    values before the update), then the update.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_due_date_conflict', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'assignment_deadline', a."student_deadline",
                          'quiz_due_date', q."due_date")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE a."student_deadline" IS NOT NULL
  AND q."due_date" IS NOT NULL
  AND a."student_deadline" <> q."due_date";

-- The quiz had no due date and its assignment has one: step 5 gives the quiz
-- the assignment's date.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_due_date_from_assignment', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'assignment_deadline', a."student_deadline")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE q."due_date" IS NULL
  AND a."student_deadline" IS NOT NULL;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_assignment_title_changed', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'old_title', a."title",
                          'new_title', q."name")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE a."title" <> q."name";

-- A published quiz whose assignment opens in the future: students saw the
-- quiz, and from now on do not until that date.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_opens_in_future', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'release_at', a."release_at",
                          'quiz_status', q."status")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE q."status" IN ('PUBLISHED', 'CLOSED')
  AND a."release_at" > now();

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_assignment_weight_changed', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'old_weight', a."weight",
                          'new_weight', q."weight")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE a."weight" <> q."weight"::double precision;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_publish_changed', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'old_is_published', a."is_published",
                          'new_is_published', q."status" IN ('PUBLISHED', 'CLOSED'),
                          'quiz_status', q."status")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
WHERE a."is_published" <> (q."status" IN ('PUBLISHED', 'CLOSED'));

-- The assignment's module wins over any QUIZ item placed elsewhere.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_item_module_differs', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', a."id",
                          'assignment_module_id', a."module_id",
                          'item_id', mi."id",
                          'item_module_id', mi."module_id")
FROM "quizzes" q
JOIN "assignments" a ON a."quiz_id" = q."id"
JOIN "module_items" mi ON mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
WHERE mi."module_id" <> a."module_id";

UPDATE "assignments" a
SET "title"            = q."name",
    "weight"           = q."weight"::double precision,
    "is_published"     = q."status" IN ('PUBLISHED', 'CLOSED'),
    "student_deadline" = COALESCE(a."student_deadline", q."due_date"),
    "updated_at"       = now()
FROM "quizzes" q
WHERE a."quiz_id" = q."id";

-- 2. Quizzes with no assignment and at least one QUIZ item in a module of
--    their own classroom. The canonical module is a published one first (the
--    one students could see the quiz in), then the lowest (position,
--    created_at, id); the item's position orders the new rows inside it.
CREATE TEMP TABLE "quiz_module" (
  "quiz_id"       TEXT PRIMARY KEY,
  "module_id"     TEXT NOT NULL,
  "item_position" INT  NOT NULL
) ON COMMIT DROP;

INSERT INTO "quiz_module" ("quiz_id", "module_id", "item_position")
SELECT DISTINCT ON (q."id") q."id", mi."module_id", mi."position"
FROM "quizzes" q
JOIN "module_items" mi ON mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
JOIN "modules" m ON m."id" = mi."module_id" AND m."classroom_id" = q."classroom_id"
WHERE NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."quiz_id" = q."id")
ORDER BY q."id", m."is_published" DESC, m."position" ASC, m."created_at" ASC, m."id" ASC;

-- The quiz's other modules, so the owner knows where it did not land.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_in_multiple_modules', q."classroom_id", q."id",
       jsonb_build_object('item_id', mi."id",
                          'module_id', mi."module_id",
                          'module_title', m."title",
                          'canonical_module_id', qm."module_id")
FROM "quiz_module" qm
JOIN "quizzes" q ON q."id" = qm."quiz_id"
JOIN "module_items" mi ON mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
JOIN "modules" m ON m."id" = mi."module_id" AND m."classroom_id" = q."classroom_id"
WHERE mi."module_id" <> qm."module_id";

-- An item that points at a quiz from a module of ANOTHER classroom places
-- nothing (no screen ever showed it there). Reported, never followed.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_item_foreign_module', q."classroom_id", q."id",
       jsonb_build_object('item_id', mi."id",
                          'module_id', mi."module_id",
                          'module_classroom_id', m."classroom_id")
FROM "quizzes" q
JOIN "module_items" mi ON mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
JOIN "modules" m ON m."id" = mi."module_id"
WHERE m."classroom_id" <> q."classroom_id";

-- Appended after the module's current assignments, one position each. The
-- ROW_NUMBER keeps several new rows in one module from sharing a position.
CREATE TEMP TABLE "quiz_assignment_new" (
  "assignment_id" TEXT PRIMARY KEY,
  "quiz_id"       TEXT NOT NULL,
  "module_id"     TEXT NOT NULL,
  "position"      INT  NOT NULL
) ON COMMIT DROP;

INSERT INTO "quiz_assignment_new" ("assignment_id", "quiz_id", "module_id", "position")
SELECT gen_random_uuid()::text, qm."quiz_id", qm."module_id",
       COALESCE((SELECT max(a."position") FROM "assignments" a WHERE a."module_id" = qm."module_id"), -1)
       + ROW_NUMBER() OVER (PARTITION BY qm."module_id"
                            ORDER BY qm."item_position" ASC, q."created_at" ASC, q."id" ASC)
FROM "quiz_module" qm
JOIN "quizzes" q ON q."id" = qm."quiz_id";

INSERT INTO "assignments" ("id", "module_id", "type", "quiz_id", "title", "slug", "position",
                           "weight", "is_published", "student_deadline",
                           "created_at", "updated_at")
SELECT n."assignment_id", n."module_id", 'QUIZ', q."id", q."name",
       trim(both '-' from regexp_replace(regexp_replace(
         regexp_replace(lower(q."name"), '[^a-z0-9 -]', '', 'g'), ' +', '-', 'g'), '-+', '-', 'g')),
       n."position",
       q."weight"::double precision,
       q."status" IN ('PUBLISHED', 'CLOSED'),
       q."due_date",
       now(), now()
FROM "quiz_assignment_new" n
JOIN "quizzes" q ON q."id" = n."quiz_id";

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_assignment_created', q."classroom_id", q."id",
       jsonb_build_object('assignment_id', n."assignment_id",
                          'module_id', n."module_id",
                          'position', n."position")
FROM "quiz_assignment_new" n
JOIN "quizzes" q ON q."id" = n."quiz_id";

-- 3. Quizzes in no module keep today's behaviour and count for nothing.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_unassigned', q."classroom_id", q."id",
       jsonb_build_object('name', q."name", 'status', q."status")
FROM "quizzes" q
WHERE NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."quiz_id" = q."id");

-- 4. A CLOSED quiz stays visible with its scores and takes no new attempt:
--    its assignment is published (steps 1-2) and closes at the quiz's last
--    update. Every other assignment keeps closes_at NULL (never closes).
UPDATE "assignments" a
SET "closes_at" = q."updated_at"
FROM "quizzes" q
WHERE a."quiz_id" = q."id" AND q."status" = 'CLOSED';

-- 5. Mirror the deadline back, so readers of the quiz column agree with the
--    assignment from the first request.
UPDATE "quizzes" q
SET "due_date" = a."student_deadline"
FROM "assignments" a
WHERE a."quiz_id" = q."id"
  AND q."due_date" IS DISTINCT FROM a."student_deadline";

-- 6. Quiz weights now sit beside repo weights unscaled (a quiz at 20 next to
--    repos summing to 400 counts for 20/420). One row per classroom with quiz
--    assignments, for the owner to read before quiz scores count.
INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_weight_summary', m."classroom_id", NULL,
       jsonb_build_object(
         'quiz_assignments',   count(*) FILTER (WHERE a."type" = 'QUIZ'),
         'quiz_weight_sum',    COALESCE(sum(a."weight") FILTER (WHERE a."type" = 'QUIZ'), 0),
         'repo_weight_sum',    COALESCE(sum(a."weight") FILTER (WHERE a."type" = 'REPO'
                                                              AND NOT a."is_extra_credit"), 0),
         'zero_weight_quizzes', count(*) FILTER (WHERE a."type" = 'QUIZ' AND a."weight" = 0))
FROM "assignments" a
JOIN "modules" m ON m."id" = a."module_id"
GROUP BY m."classroom_id"
HAVING count(*) FILTER (WHERE a."type" = 'QUIZ') > 0;

-- 7. Guard.
DO $$
DECLARE
  missing INT;
  mismatched INT;
BEGIN
  SELECT count(*) INTO missing
  FROM "quizzes" q
  WHERE EXISTS (SELECT 1 FROM "module_items" mi
                JOIN "modules" m ON m."id" = mi."module_id"
                WHERE mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
                  AND m."classroom_id" = q."classroom_id")
    AND NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."quiz_id" = q."id");
  IF missing > 0 THEN
    RAISE EXCEPTION 'quiz assignments: % quiz(zes) in a module have no assignment', missing;
  END IF;

  SELECT count(*) INTO mismatched
  FROM "assignments" a
  JOIN "quizzes" q ON q."id" = a."quiz_id"
  JOIN "modules" m ON m."id" = a."module_id"
  WHERE a."type" = 'QUIZ'
    AND (a."title" <> q."name"
         OR m."classroom_id" <> q."classroom_id"
         OR a."weight" <> q."weight"::double precision
         OR q."due_date" IS DISTINCT FROM a."student_deadline");
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'quiz assignments: % quiz assignment(s) disagree with their quiz', mismatched;
  END IF;
END $$;

INSERT INTO "coursework_migration_report" ("id", "kind", "classroom_id", "subject_id", "details")
SELECT gen_random_uuid()::text, 'quiz_assignments_summary', NULL, NULL, jsonb_build_object(
  'quizzes',                (SELECT count(*) FROM "quizzes"),
  'quiz_assignments',       (SELECT count(*) FROM "assignments" WHERE "type" = 'QUIZ'),
  'assignments_created',    (SELECT count(*) FROM "quiz_assignment_new"),
  'unassigned',             (SELECT count(*) FROM "quizzes" q
                             WHERE NOT EXISTS (SELECT 1 FROM "assignments" a WHERE a."quiz_id" = q."id")),
  'closed_quizzes',         (SELECT count(*) FROM "quizzes" WHERE "status" = 'CLOSED'),
  'due_date_conflicts',     (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_due_date_conflict'),
  'due_dates_from_assignment', (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_due_date_from_assignment'),
  'titles_changed',         (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_assignment_title_changed'),
  'opens_in_future',        (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_opens_in_future'),
  'weights_changed',        (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_assignment_weight_changed'),
  'publish_changed',        (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_publish_changed'),
  'item_module_differs',    (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_item_module_differs'),
  'in_multiple_modules',    (SELECT count(DISTINCT "subject_id") FROM "coursework_migration_report" WHERE "kind" = 'quiz_in_multiple_modules'),
  'foreign_module_items',   (SELECT count(*) FROM "coursework_migration_report" WHERE "kind" = 'quiz_item_foreign_module'));
