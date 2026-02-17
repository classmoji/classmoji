-- AlterTable
ALTER TABLE "slides" ADD COLUMN     "allow_team_edit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_draft" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "show_speaker_notes" BOOLEAN NOT NULL DEFAULT false;
