-- CreateTable
CREATE TABLE "classroom_invites" (
    "id" TEXT NOT NULL,
    "school_email" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classroom_invites_school_email_student_id_idx" ON "classroom_invites"("school_email", "student_id");

-- CreateIndex
CREATE INDEX "classroom_invites_classroom_id_idx" ON "classroom_invites"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_invites_school_email_classroom_id_key" ON "classroom_invites"("school_email", "classroom_id");

-- AddForeignKey
ALTER TABLE "classroom_invites" ADD CONSTRAINT "classroom_invites_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
