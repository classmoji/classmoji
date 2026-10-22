-- Who resolved a regrade/resubmit request, and when. Null on open requests
-- and on rows resolved before this was recorded.
-- AlterTable
ALTER TABLE "regrade_requests" ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "resolved_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "regrade_requests" ADD CONSTRAINT "regrade_requests_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
