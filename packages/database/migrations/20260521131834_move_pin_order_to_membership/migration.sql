-- Move pin_order from Classroom to ClassroomMembership so it is per-user
-- (a single user may have multiple memberships in the same classroom across
-- different roles; pinning one role should not pin the other).

ALTER TABLE "classroom_memberships" ADD COLUMN "pin_order" INTEGER;

-- Best-effort backfill: copy each classroom's pin_order onto every existing
-- membership. Loses some information for users with multiple memberships in
-- the same classroom — but in practice that's rare and the existing pin set
-- was effectively per-classroom anyway.
UPDATE "classroom_memberships" m
SET "pin_order" = c."pin_order"
FROM "classrooms" c
WHERE m."classroom_id" = c."id" AND c."pin_order" IS NOT NULL;

ALTER TABLE "classrooms" DROP COLUMN "pin_order";
