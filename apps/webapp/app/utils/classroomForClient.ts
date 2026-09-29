/**
 * A classroom as a loader returns it to the page: its own fields and settings
 * as `getClassroomForUI` gives them (the UI-safe settings), and its git
 * organization as the pages read it — `id`, `login`, `provider` and
 * `provider_id`.
 *
 * For a loader's RETURN only. Server code keeps the classroom it was handed:
 * `getGitProvider()` and friends need the full organization row.
 */

interface GitOrganizationLike {
  id: string;
  login: string;
  provider: string;
  provider_id: string;
}

export interface ClientGitOrganization {
  id: string;
  login: string;
  provider: string;
  provider_id: string;
}

export const classroomForClient = <
  T extends { git_organization?: GitOrganizationLike | null | undefined },
>(
  classroom: T
): Omit<T, 'git_organization'> & { git_organization: ClientGitOrganization | null } => {
  const { git_organization: gitOrganization, ...rest } = classroom;
  return {
    ...rest,
    git_organization: gitOrganization
      ? {
          id: gitOrganization.id,
          login: gitOrganization.login,
          provider: gitOrganization.provider,
          provider_id: gitOrganization.provider_id,
        }
      : null,
  };
};
