-- classmoji:no-transaction: the index build must not block writes to audit_logs
-- The admin app lists one person's audit rows newest first.
CREATE INDEX CONCURRENTLY "audit_logs_user_id_timestamp_idx" ON "audit_logs"("user_id", "timestamp");
