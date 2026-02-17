-- CreateEnum
CREATE TYPE "TeamFormationMode" AS ENUM ('INSTRUCTOR', 'SELF_FORMED');

-- AlterTable
ALTER TABLE "modules" ADD COLUMN     "max_team_size" INTEGER,
ADD COLUMN     "team_formation_deadline" TIMESTAMP(3),
ADD COLUMN     "team_formation_mode" "TeamFormationMode" DEFAULT 'INSTRUCTOR';
