-- The admin Modules screen can now arrange coursework by hand: module cards on
-- the page, and the rows inside each card. Module.position already existed but
-- nothing ever wrote it (every row sat at 0 and the list fell back to
-- created_at); assignments had no order of their own at all.
--
-- Both columns are backfilled with the order the screen shows today, so the
-- first drag rearranges what the instructor was already looking at.

ALTER TABLE "assignments" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Assignments: deadline first (undated last), then title — the old sort.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY module_id
      ORDER BY student_deadline ASC NULLS LAST, title ASC
    ) - 1 AS pos
  FROM "assignments"
)
UPDATE "assignments" a
SET "position" = o.pos
FROM ordered o
WHERE a.id = o.id;

-- Modules: every row is at 0 today, so the displayed order is created_at.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY classroom_id
      ORDER BY position ASC, created_at ASC
    ) - 1 AS pos
  FROM "modules"
)
UPDATE "modules" m
SET "position" = o.pos
FROM ordered o
WHERE m.id = o.id;
