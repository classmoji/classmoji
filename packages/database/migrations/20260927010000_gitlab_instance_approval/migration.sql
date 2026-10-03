-- Gitlab instances need a platform admin's approval before anyone can sign in
-- through them. Instances registered before this change stay usable.
ALTER TABLE "gitlab_instances"
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "requester_name" TEXT,
  ADD COLUMN "requester_username" TEXT,
  ADD COLUMN "requester_email" TEXT,
  ADD COLUMN "requester_email_confirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requester_is_admin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requester_since" TIMESTAMP(3),
  ADD COLUMN "request_note" TEXT;

UPDATE "gitlab_instances" SET "approved_at" = "created_at";
