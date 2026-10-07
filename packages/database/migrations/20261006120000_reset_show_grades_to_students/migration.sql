-- Turn the student grade estimate off in every classroom.
--
-- classroom_settings.show_grades_to_students now shows students an estimated
-- grade on their dashboard. Until now nothing read it, but GitHub Classroom
-- imports and example classrooms were created with it on, and some owners
-- set it while the old switch existed. Owners opt in from Settings → Grades.
--
-- Data only; no schema change.
-- ---------------------------------------------------------------------------

UPDATE "classroom_settings"
SET "show_grades_to_students" = false
WHERE "show_grades_to_students" = true;
