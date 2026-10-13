-- New classrooms start with live editing on. Existing rows are switched on
-- separately, with an audit row per classroom.
ALTER TABLE "classrooms" ALTER COLUMN "collab_enabled" SET DEFAULT true;
