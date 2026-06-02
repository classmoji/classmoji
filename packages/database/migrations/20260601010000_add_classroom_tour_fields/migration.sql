-- Mark auto-provisioned per-user "Example Course" sandboxes used by the in-classroom tour.
ALTER TABLE "classrooms" ADD COLUMN "is_example" BOOLEAN NOT NULL DEFAULT false;

-- Per-(user, classroom, role) completion stamp for the in-classroom guided tour.
-- Null means not yet completed; no backfill needed (no example classrooms exist yet).
ALTER TABLE "classroom_memberships" ADD COLUMN "tour_completed_at" TIMESTAMP(3);
