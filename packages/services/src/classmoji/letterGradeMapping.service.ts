import prisma from '@classmoji/database';

export const save = async (classroomId: string, values: { letter_grade: string; [key: string]: any }) => {
  return prisma!.letterGradeMapping.upsert({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: values.letter_grade,
      },
    },
    update: values,
    create: { classroom_id: classroomId, ...values },
  } as any);
};

export const findByClassroomId = async (classroomId: string) => {
  return prisma!.letterGradeMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { min_grade: 'desc' },
  });
};

const deleteMapping = async (classroomId: string, letterGrade: string) => {
  return prisma!.letterGradeMapping.delete({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: letterGrade,
      },
    },
  });
};
export { deleteMapping as delete };
