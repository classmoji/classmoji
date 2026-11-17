/**
 * A classroom as a loader returns it to the page: its own fields and settings
 * as `getClassroomForUI` gives them (the UI-safe settings) except `join_code`
 * and `plan_owner_id`, and its git organization as the pages read it — `id`,
 * `login`, `provider`, `provider_id` and `base_url` (a self-managed Gitlab's
 * host, which every link on that Gitlab needs), never its credential columns.
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

/**
 * Classroom columns no page reads: the invite link's code (a credential, owner
 * only, served by its own loader field) and the plan owner's user id.
 */
type ServerOnlyClassroomColumn = 'join_code' | 'plan_owner_id';

export const classroomForClient = <
  T extends { git_organization?: GitOrganizationLike | null | undefined },
>(
  classroom: T
): Omit<T, 'git_organization' | ServerOnlyClassroomColumn> & {
  git_organization: ClientGitOrganization | null;
} => {
  const {
    git_organization: gitOrganization,
    join_code: _joinCode,
    plan_owner_id: _planOwnerId,
    ...rest
  } = classroom as T & { join_code?: unknown; plan_owner_id?: unknown };
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
