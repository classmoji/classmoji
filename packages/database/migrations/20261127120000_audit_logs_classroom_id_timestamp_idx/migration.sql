-- classmoji:no-transaction: the index build must not block writes to audit_logs
-- The admin app lists one classroom's audit rows newest first.
CREATE INDEX CONCURRENTLY "audit_logs_classroom_id_timestamp_idx" ON "audit_logs"("classroom_id", "timestamp");
