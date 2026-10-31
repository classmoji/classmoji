-- AlterTable
ALTER TABLE "classrooms" ADD COLUMN     "join_code" TEXT,
ADD COLUMN     "join_link_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_join_code_key" ON "classrooms"("join_code");
