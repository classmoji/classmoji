import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

type LetterGradeMappingInput = Prisma.LetterGradeMappingUncheckedCreateWithoutClassroomInput;

export const save = async (classroomId: string, values: LetterGradeMappingInput) => {
  return getPrisma().letterGradeMapping.upsert({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: values.letter_grade,
      },
    },
    update: values,
    create: { classroom_id: classroomId, ...values },
  });
};

export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().letterGradeMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { min_grade: 'desc' },
  });
};

const deleteMapping = async (classroomId: string, letterGrade: string) => {
  return getPrisma().letterGradeMapping.delete({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: letterGrade,
      },
    },
  });
};
export { deleteMapping as delete };
