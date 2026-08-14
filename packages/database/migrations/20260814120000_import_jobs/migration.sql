-- Classroom IMPORT becomes a background job with a tracked progress bar.
--
-- Copying a source classroom (settings, repositories, template duplication,
-- pages/slides content, modules) used to run inside the create-classroom
-- action. On a real classroom that is a multi-minute request — a live import
-- ran past 10 minutes — which risks a proxy timeout and shows the user nothing
-- but a spinner. The work now runs in the `classroom-import` Trigger.dev task,
-- and this table is the durable handoff: the action creates the row and
-- triggers the task, the task advances phase/progress/warnings, and the admin
-- dashboard polls the row to draw the bar.

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
-- `selections` carries the whole import request (settings groups, repository
-- ids with their includeQuizzes flags, content/module toggles) so the trigger
-- payload stays a bare { importJobId } and the run is replayable from the row.
-- `progress` holds the per-phase shape documented in schema.prisma and built by
-- @classmoji/services `importProgress.ts`.
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "source_classroom_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "phase" TEXT,
    "selections" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ONE import per classroom. The per-item creates (pages, decks, repositories)
-- are not idempotent, so a second job for the same classroom would silently
-- duplicate content — the constraint makes that unrepresentable rather than
-- relying on callers to check first.
CREATE UNIQUE INDEX "import_jobs_classroom_id_key" ON "import_jobs"("classroom_id");

-- CreateIndex
-- Supports sweeping for non-terminal jobs (PENDING/RUNNING) without scanning.
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");

-- AddForeignKey
-- Cascade: an import job describes work on exactly one classroom and has no
-- meaning once that classroom is deleted.
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
