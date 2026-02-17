import prisma from '@classmoji/database';

export const save = async (classroomId, values) => {
  return prisma.letterGradeMapping.upsert({
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

export const findByClassroomId = async classroomId => {
  return prisma.letterGradeMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { min_grade: 'desc' },
  });
};

const deleteMapping = async (classroomId, letterGrade) => {
  return prisma.letterGradeMapping.delete({
    where: {
      classroom_id_letter_grade: {
        classroom_id: classroomId,
        letter_grade: letterGrade,
      },
    },
  });
};
export { deleteMapping as delete };
