/**
 * Payload builder for the `remove_user_from_organization` task.
 *
 * The task reads a small, fixed set of fields: the classroom id and slug (the
 * membership delete and the GitHub team name), and the git-organization fields
 * the provider factory resolves (getGitProvider in ../git/index.ts). Run
 * payloads are stored and rendered by the task runner, so the payload is built
 * field by field from those — handing over a whole classroom or organization
 * record would ship every column on it, including the ones no task reads.
 *
 * Shared by staff.service.removeStaff and the MCP roster_remove_student tool so
 * both produce the identical shape from the same list of fields.
 */

/** The classroom fields the removal task reads. */
export interface RemoveUserClassroom {
  id: string;
  slug: string;
}

/** The git-organization fields the provider factory resolves. */
export interface RemoveUserGitOrganization {
  id: string;
  login: string;
  provider: string;
  github_installation_id: string | null;
  base_url: string | null;
}

export interface RemoveUserPayload {
  user: { id: string; login: string | null; has_accepted_invite: boolean };
  classroom: RemoveUserClassroom;
  gitOrganization: RemoveUserGitOrganization | null;
  role: string;
}

/**
 * Build the task payload from a loaded classroom record (with its
 * git_organization) and the membership being removed.
 *
 * A classroom with no linked git organization yields `gitOrganization: null`;
 * the task asserts on it and stops, exactly as it does for any other payload
 * that cannot name an organization.
 */
export const buildRemoveUserPayload = ({
  user,
  classroom,
  role,
}: {
  user: { id: string; login: string | null; has_accepted_invite: boolean };
  classroom: {
    id: string;
    slug: string;
    git_organization?: {
      id: string;
      login: string;
      provider: string;
      github_installation_id?: string | null;
      base_url?: string | null;
    } | null;
  };
  role: string;
}): RemoveUserPayload => {
  const gitOrganization = classroom.git_organization;

  return {
    user: {
      id: user.id,
      login: user.login,
      has_accepted_invite: user.has_accepted_invite,
    },
    classroom: { id: classroom.id, slug: classroom.slug },
    gitOrganization: gitOrganization
      ? {
          id: gitOrganization.id,
          login: gitOrganization.login,
          provider: gitOrganization.provider,
          github_installation_id: gitOrganization.github_installation_id ?? null,
          base_url: gitOrganization.base_url ?? null,
        }
      : null,
    role,
  };
};
