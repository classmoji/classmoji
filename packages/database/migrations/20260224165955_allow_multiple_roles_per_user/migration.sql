/*
  Warnings:

  - A unique constraint covering the columns `[classroom_id,user_id,role]` on the table `classroom_memberships` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "classroom_memberships_classroom_id_user_id_key";

-- CreateIndex
CREATE INDEX "classroom_memberships_classroom_id_user_id_idx" ON "classroom_memberships"("classroom_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_memberships_classroom_id_user_id_role_key" ON "classroom_memberships"("classroom_id", "user_id", "role");
