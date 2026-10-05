-- Live-editing bookkeeping on the collab buffer, plus audit actions.
--
-- editors: co-authors since the last push ({ userId, name }[]), merged by the
--   collab store hook so a collab restart keeps the commit's co-author
--   trailers; the content-checkpoint worker clears/trims it after a push.
-- last_checkpoint_at / last_checkpoint_error: outcome of the doc's last
--   checkpoint run (error = refusal/failure code + message, null on success).
-- last_conflict: the last outside-push conflict summary ({ at, sha, ids[] }).
ALTER TABLE "collab_docs" ADD COLUMN "editors" JSONB;
ALTER TABLE "collab_docs" ADD COLUMN "last_checkpoint_at" TIMESTAMP(3);
ALTER TABLE "collab_docs" ADD COLUMN "last_checkpoint_error" TEXT;
ALTER TABLE "collab_docs" ADD COLUMN "last_conflict" JSONB;

-- Joining/leaving a live room and checkpoint pushes are audited; refused
-- joins use the existing ACCESS_DENIED.
ALTER TYPE "AuditLogAction" ADD VALUE 'COLLAB_JOIN';
ALTER TYPE "AuditLogAction" ADD VALUE 'COLLAB_LEAVE';
ALTER TYPE "AuditLogAction" ADD VALUE 'COLLAB_CHECKPOINT';
