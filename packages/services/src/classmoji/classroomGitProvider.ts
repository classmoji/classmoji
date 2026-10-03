import getPrisma, { type GitUsernameScope } from '@classmoji/database';

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

/**
 * Where a member's `login` in this classroom is looked up: its organization's
 * provider and, on GitLab, its server (usernames are unique per server).
 */
export const findClassroomGitScope = async (classroomId: string): Promise<GitUsernameScope> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: { git_organization: { select: { provider: true, gitlab_instance_id: true } } },
  });
  return classroom?.git_organization ?? 'GITHUB';
};
