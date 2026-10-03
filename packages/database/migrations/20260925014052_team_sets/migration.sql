-- CreateEnum
CREATE TYPE "TeamSetRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SOLVED', 'INFEASIBLE', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "team_sets" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "tag_id" TEXT,
    "created_run_id" TEXT,
    "create_state" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_set_runs" (
    "id" TEXT NOT NULL,
    "team_set_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "TeamSetRunStatus" NOT NULL DEFAULT 'QUEUED',
    "config" JSONB NOT NULL,
    "problem" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "seed" INTEGER NOT NULL,
    "engine" TEXT NOT NULL,
    "result" JSONB,
    "metrics" JSONB,
    "solver" JSONB,
    "diagnostics" JSONB,
    "error" TEXT,
    "trigger_run_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "team_set_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_sets_classroom_id_idx" ON "team_sets"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_sets_form_id_name_key" ON "team_sets"("form_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_set_runs_team_set_id_number_key" ON "team_set_runs"("team_set_id", "number");

-- AddForeignKey
ALTER TABLE "team_sets" ADD CONSTRAINT "team_sets_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_sets" ADD CONSTRAINT "team_sets_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_sets" ADD CONSTRAINT "team_sets_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_sets" ADD CONSTRAINT "team_sets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_set_runs" ADD CONSTRAINT "team_set_runs_team_set_id_fkey" FOREIGN KEY ("team_set_id") REFERENCES "team_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_set_runs" ADD CONSTRAINT "team_set_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

