/**
 * A classroom as a loader returns it to the page: its own fields and settings
 * as `getClassroomForUI` gives them (the UI-safe settings), and its git
 * organization as the pages read it — `id`, `login`, `provider`,
 * `provider_id` and `base_url` (a self-managed Gitlab's host, which every link
 * on that Gitlab needs).
 *
 * For a loader's RETURN only. Server code keeps the classroom it was handed:
 * `getGitProvider()` and friends need the full organization row.
 */

interface GitOrganizationLike {
  id: string;
  login: string;
  provider: string;
  provider_id: string;
  base_url?: string | null;
}

export interface ClientGitOrganization {
  id: string;
  login: string;
  provider: string;
  provider_id: string;
  base_url: string | null;
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
          base_url: gitOrganization.base_url ?? null,
        }
      : null,
  };
};
