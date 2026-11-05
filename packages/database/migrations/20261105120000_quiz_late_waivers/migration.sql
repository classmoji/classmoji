-- Quiz late waivers (#813): staff waive the late penalty for one student on one
-- QUIZ assignment. Classroom-scoped by a copied classroom_id.
-- CreateTable
CREATE TABLE "quiz_late_waivers" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_late_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_late_waivers_classroom_id_idx" ON "quiz_late_waivers"("classroom_id");

-- CreateIndex
CREATE INDEX "quiz_late_waivers_student_id_idx" ON "quiz_late_waivers"("student_id");

-- CreateIndex
CREATE INDEX "quiz_late_waivers_created_by_id_idx" ON "quiz_late_waivers"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_late_waivers_assignment_id_student_id_key" ON "quiz_late_waivers"("assignment_id", "student_id");

-- AddForeignKey
ALTER TABLE "quiz_late_waivers" ADD CONSTRAINT "quiz_late_waivers_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_late_waivers" ADD CONSTRAINT "quiz_late_waivers_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_late_waivers" ADD CONSTRAINT "quiz_late_waivers_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_late_waivers" ADD CONSTRAINT "quiz_late_waivers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
