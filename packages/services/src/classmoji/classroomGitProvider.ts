import getPrisma from '@classmoji/database';

/**
 * The git provider of a classroom's organization. A member's `login` in that
 * classroom is their username on this provider; Github when the classroom has
 * no organization.
 */
export const findClassroomGitProvider = async (classroomId: string): Promise<string> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: { git_organization: { select: { provider: true } } },
  });
  return classroom?.git_organization?.provider ?? 'GITHUB';
};
