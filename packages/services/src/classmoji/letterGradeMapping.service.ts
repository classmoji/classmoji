import getPrisma from '@classmoji/database';

/** The fields one letter grade threshold is saved with; nothing else is written. */
export interface LetterGradeMappingFields {
  letter_grade: string;
  min_grade: number;
}

/**
 * Add or update one letter grade threshold of `classroomId` (the settings
 * table, MCP `letter_grade_mapping_upsert`). Writes only `min_grade`, to that
 * classroom's row for `letter_grade`: the row's id and classroom are never
 * taken from `values`.
 */
export const save = async (classroomId: string, values: LetterGradeMappingFields) => {
  return getPrisma().letterGradeMapping.upsert({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: values.letter_grade,
      },
    },
    update: { min_grade: values.min_grade },
    create: {
      classroom_id: classroomId,
      letter_grade: values.letter_grade,
      min_grade: values.min_grade,
    },
  });
};

export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().letterGradeMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { min_grade: 'desc' },
  });
};

/**
 * Delete one letter grade of `classroomId`. Returns how many rows went (0 or
 * 1); a letter grade that is not a non-empty string deletes nothing.
 */
const deleteMapping = async (classroomId: string, letterGrade: unknown) => {
  if (typeof letterGrade !== 'string' || letterGrade === '' || !classroomId) return { count: 0 };
  return getPrisma().letterGradeMapping.deleteMany({
    where: { classroom_id: classroomId, letter_grade: letterGrade },
  });
};
export { deleteMapping as delete };
