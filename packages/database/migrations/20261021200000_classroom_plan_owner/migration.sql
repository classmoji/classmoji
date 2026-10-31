-- Who created a classroom (provenance only) and whose Free-plan slot it
-- consumes when no accepted owner is Pro.
ALTER TABLE "classrooms" ADD COLUMN "created_by" TEXT;
ALTER TABLE "classrooms" ADD COLUMN "plan_owner_id" TEXT;

-- created_by stays NULL for existing rows: the oldest owner is a plan-owner
-- policy, not proof of who created the class.
-- plan_owner_id: the oldest accepted OWNER, the same person the Pro resolver
-- fell back to before this column existed.
UPDATE "classrooms" c
SET "plan_owner_id" = o."user_id"
FROM (
  SELECT DISTINCT ON (m."classroom_id") m."classroom_id", m."user_id"
  FROM "classroom_memberships" m
  WHERE m."role" = 'OWNER' AND m."has_accepted_invite" = true
  ORDER BY m."classroom_id", m."created_at" ASC, m."id" ASC
) o
WHERE o."classroom_id" = c."id";

CREATE INDEX "classrooms_plan_owner_id_status_idx" ON "classrooms"("plan_owner_id", "status");
CREATE INDEX "classrooms_created_by_idx" ON "classrooms"("created_by");

ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_plan_owner_id_fkey" FOREIGN KEY ("plan_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
