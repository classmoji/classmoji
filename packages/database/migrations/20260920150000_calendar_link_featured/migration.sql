-- One linked resource per event date can be starred for the month view.
--
-- The week view lists everything an event links to. A month cell has room for
-- a single line under the chip, so the instructor picks which link that line
-- shows — a star on the chip in the add/edit modal — and `featured` is where
-- that choice is stored. No star means the month view shows nothing under the
-- event, which is what it shows today; the column therefore backfills to false
-- for every existing row and changes nothing that is already on screen.
--
-- It lives on the LINK row rather than on the event, because a link belongs to
-- one occurrence date: a weekly lecture stars this week's deck and next week's
-- reading, and an event-level column could not hold both. It is also why a
-- `this_and_future` split needs no extra work — it moves whole link rows to the
-- new event, and the star rides along on the row it belongs to.
--
-- ── WHY TWO PARTIAL INDEXES PER TABLE, AND WHAT THEY DO NOT COVER ───────────
-- "Only one starred resource per date" spans all three tables, and no index can
-- say that: a unique index covers one table. The rule is enforced where it can
-- be — `updateEventLinks` takes `SELECT … FOR UPDATE` on the parent event row
-- and then writes the star onto exactly one created row, so two concurrent
-- saves of the same event serialize rather than each inserting a star (Read
-- Committed alone would let both through, since neither sees the other's
-- uncommitted row).
--
-- These indexes are the backstop underneath that: within one table a second
-- starred row for the same (event, date) is refused by the database, whatever
-- writes it. Two per table because Postgres treats NULLs as distinct, so the
-- first index does not constrain the undated bucket a non-recurring event's
-- links live in — the same reason the calendar_event_resource_links migration
-- added a `_null_date` twin for each of its unique constraints.
ALTER TABLE "calendar_event_page_links" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "calendar_event_slide_links" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "calendar_event_assignment_links" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_page_links_featured" ON "calendar_event_page_links"("event_id", "occurrence_date") WHERE "featured";

CREATE UNIQUE INDEX "calendar_event_page_links_featured_null_date" ON "calendar_event_page_links"("event_id") WHERE "featured" AND "occurrence_date" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_slide_links_featured" ON "calendar_event_slide_links"("event_id", "occurrence_date") WHERE "featured";

CREATE UNIQUE INDEX "calendar_event_slide_links_featured_null_date" ON "calendar_event_slide_links"("event_id") WHERE "featured" AND "occurrence_date" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_assignment_links_featured" ON "calendar_event_assignment_links"("event_id", "occurrence_date") WHERE "featured";

CREATE UNIQUE INDEX "calendar_event_assignment_links_featured_null_date" ON "calendar_event_assignment_links"("event_id") WHERE "featured" AND "occurrence_date" IS NULL;
