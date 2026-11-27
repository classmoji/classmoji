-- Audit log rows: a repeat count for merged reads, and a role that may be
-- empty on an ACCESS_DENIED row (a refused non-member holds no classroom role).
--
-- Additive for clients built against the previous schema: `count` has a
-- default, so their inserts still work, and they never select it. Every
-- other action must still carry a role (the CHECK below).
--
-- Metadata-only: a constant default adds no rewrite, DROP NOT NULL scans
-- nothing, and the CHECK is added NOT VALID, so it is enforced on every row
-- written from now on without scanning the table under this lock. The rows
-- already there all have a role (the column was NOT NULL until this
-- statement), so none can break it.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_logs"
  ADD COLUMN "count" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "role" DROP NOT NULL,
  ADD CONSTRAINT "audit_logs_role_required_check"
    CHECK ("role" IS NOT NULL OR "action" = 'ACCESS_DENIED') NOT VALID;

COMMIT;
