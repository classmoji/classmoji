import { GitProvider } from './GitProvider.ts';
import type { GitRepository } from './GitProvider.ts';
import type {
  CommitRecord,
  ContributorRecord,
  LanguagesMap,
  PRSummary,
} from '../classmoji/repoAnalytics.types.ts';

/** Base URL of the GitLab instance (self-hosted instances override this). */
function gitlabBaseUrl(): string {
  return (process.env.GITLAB_URL || process.env.GITLAB_ISSUER || 'https://gitlab.com').replace(
    /\/+$/,
    ''
  );
}

/**
 * GitLab access levels, plus the GitHub permission names the rest of the
 * codebase already speaks, mapped onto their GitLab equivalents.
 * @see https://docs.gitlab.com/ee/api/members.html#roles
 */
const ACCESS_LEVELS: Record<string, number> = {
  // GitLab's own role names
  guest: 10,
  reporter: 20,
  developer: 30,
  maintainer: 40,
  owner: 50,
  // GitHub permission names, for callers written against GitHubProvider
  pull: 20,
  triage: 20,
  push: 30,
  maintain: 40,
  admin: 50,
};

/** Reporter — the level a plain organization invite lands on. */
const REPORTER_ACCESS_LEVEL = 20;

/** GitLab derives a project/group `path` from its name; mirror that slugging. */
function toPath(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * GitLab adapter - implements GitProvider interface.
 * Uses GitLab Group for organization-level access.
 *
 * Terminology mapping:
 * - GitHub Organization → GitLab Group
 * - GitHub Repository → GitLab Project
 * - GitHub Team → GitLab Subgroup (or Group members with roles)
 */
export class GitLabProvider extends GitProvider {
  groupId: string;
  groupPath: string | null;
  _client: unknown;

  /**
   * The access token lives in a private field, and is deliberately kept out of
   * `credentials` and every public property. Anything that enumerates or
   * serialises a provider — a log line, an error dump, `JSON.stringify` — would
   * otherwise carry a live personal access token along with it.
   */
  #token: string | null;

  /**
   * @param {string} groupId - GitLab Group ID
   * @param {string} [groupPath] - Group path/slug (optional)
   * @param {string} [token] - GitLab access token used to authenticate API calls
   */
  constructor(groupId: string, groupPath: string | null = null, token: string | null = null) {
    super({ groupId, groupPath });
    this.groupId = groupId;
    this.groupPath = groupPath;
    this.#token = token;
    this._client = null;
  }

  // ─── REST plumbing ─────────────────────────────────────────────────────────

  /**
   * Issue a GitLab REST API call and parse the response.
   *
   * Returns the status alongside the parsed body rather than throwing, so a
   * caller that treats a particular failure as expected (a subgroup path
   * already taken, say) can branch on it. Callers with no such case should use
   * {@link GitLabProvider.api} instead, which throws.
   */
  async request(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    if (!this.#token) {
      throw new Error('GitLabProvider requires an access token for API calls');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/json',
    };
    const options: { method: string; headers: Record<string, string>; body?: string } = {
      method: init.method || 'GET',
      headers,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(init.body);
    }

    const res = await fetch(`${gitlabBaseUrl()}${path}`, options);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: res.ok, status: res.status, body };
  }

  /** {@link GitLabProvider.request}, but throws on a non-2xx response. */
  async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const { ok, status, body } = await this.request(path, init);
    if (!ok) {
      const message =
        body && typeof body === 'object' && 'message' in body
          ? JSON.stringify((body as { message: unknown }).message)
          : String(body ?? '');
      throw new Error(`GitLab API ${init.method || 'GET'} ${path} failed (${status}): ${message}`);
    }
    return body;
  }

  /** Resolve a group path (or numeric id) to its numeric group id. */
  async resolveGroupId(group: string): Promise<number> {
    const body = (await this.api(`/api/v4/groups/${encodeURIComponent(group)}`)) as { id: number };
    return body.id;
  }

  /** Resolve a username to its numeric user id, or null when no user matches. */
  async resolveUserId(username: string): Promise<number | null> {
    const users = (await this.api(
      `/api/v4/users?username=${encodeURIComponent(username)}`
    )) as Array<{ id: number }>;
    return users.length > 0 ? users[0].id : null;
  }

  // ─── Auth & User ───────────────────────────────────────────────────────────

  /**
   * Get an access token for GitLab API
   * @returns {Promise<string>} GitLab access token
   */
  async getAccessToken(): Promise<never> {
    // TODO: Implement GitLab OAuth token retrieval
    throw new Error('GitLabProvider.getAccessToken() not implemented');
  }

  /**
   * Get current authenticated user from a personal access token
   * @param {string} token - Personal access token
   * @returns {Promise<Object>} GitLab user data
   */
  async getCurrentUser(_token: string): Promise<never> {
    // TODO: GET /api/v4/user
    throw new Error('GitLabProvider.getCurrentUser() not implemented');
  }

  // ─── Repository (Project) ─────────────────────────────────────────────────

  /**
   * Create a project in the group
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @param {boolean} isPrivate - Whether project is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepository(
    group: string,
    name: string,
    isPrivate: boolean = true
  ): Promise<GitRepository> {
    const namespaceId = await this.resolveGroupId(group);

    const project = (await this.api('/api/v4/projects', {
      method: 'POST',
      body: {
        name,
        path: toPath(name),
        namespace_id: namespaceId,
        visibility: isPrivate ? 'private' : 'public',
      },
    })) as { id: number; path: string; web_url: string };

    return { id: String(project.id), name: project.path, url: project.web_url };
  }

  /**
   * Create a project from a template
   * @param {string} group - Group path
   * @param {string} name - New project name
   * @param {string} templateOwner - Template namespace
   * @param {string} templateRepo - Template project name
   * @param {boolean} isPrivate - Whether project is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepositoryFromTemplate(
    _group: string,
    _name: string,
    _templateOwner: string,
    _templateRepo: string,
    _isPrivate: boolean = true
  ): Promise<never> {
    // TODO: POST /api/v4/projects with import_url or fork
    throw new Error('GitLabProvider.createRepositoryFromTemplate() not implemented');
  }

  /**
   * Create a public project
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @param {string} description - Project description
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createPublicRepository(
    _group: string,
    _name: string,
    _description: string = ''
  ): Promise<never> {
    // TODO: POST /api/v4/projects with visibility: 'public'
    throw new Error('GitLabProvider.createPublicRepository() not implemented');
  }

  /**
   * Check if project exists
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @returns {Promise<boolean>}
   */
  async repositoryExists(_group: string, _name: string): Promise<never> {
    // TODO: GET /api/v4/projects/:id (URL-encoded group/name)
    throw new Error('GitLabProvider.repositoryExists() not implemented');
  }

  /**
   * Delete a project
   * @param {string} group - Group path
   * @param {string} name - Project name
   */
  async deleteRepository(_group: string, _name: string): Promise<never> {
    // TODO: DELETE /api/v4/projects/:id
    throw new Error('GitLabProvider.deleteRepository() not implemented');
  }

  // ─── Branches & Merge Requests ────────────────────────────────────────────

  /**
   * Get the latest commit SHA for a branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch name (default: main)
   * @returns {Promise<string>} Commit SHA
   */
  async getLatestCommitSHA(
    _group: string,
    _project: string,
    _branch: string = 'main'
  ): Promise<never> {
    // TODO: GET /api/v4/projects/:id/repository/branches/:branch
    throw new Error('GitLabProvider.getLatestCommitSHA() not implemented');
  }

  async listCommits(
    _group: string,
    _project: string,
    _opts?: { since?: string; branch?: string }
  ): Promise<CommitRecord[]> {
    throw new Error('GitLabProvider.listCommits() not implemented');
  }

  async getContributorStats(
    _group: string,
    _project: string
  ): Promise<{ pending: true } | ContributorRecord[]> {
    throw new Error('GitLabProvider.getContributorStats() not implemented');
  }

  async getLanguages(_group: string, _project: string): Promise<LanguagesMap> {
    throw new Error('GitLabProvider.getLanguages() not implemented');
  }

  async listPulls(_group: string, _project: string): Promise<PRSummary> {
    throw new Error('GitLabProvider.listPulls() not implemented');
  }

  /**
   * Create a new branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - New branch name
   * @param {string} sha - Commit SHA to branch from
   */
  async createBranch(
    _group: string,
    _project: string,
    _branch: string,
    _sha: string
  ): Promise<never> {
    // TODO: POST /api/v4/projects/:id/repository/branches
    throw new Error('GitLabProvider.createBranch() not implemented');
  }

  /**
   * Protect a branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch name
   */
  async protectBranch(_group: string, _project: string, _branch: string): Promise<never> {
    // TODO: POST /api/v4/projects/:id/protected_branches
    throw new Error('GitLabProvider.protectBranch() not implemented');
  }

  /**
   * Create a merge request (equivalent to GitHub PR)
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} targetBranch - Target branch
   * @param {string} sourceBranch - Source branch
   * @param {string} title - MR title
   * @param {string} description - MR description
   * @returns {Promise<{id: number, iid: number, url: string}>}
   */
  async createPullRequest(
    _group: string,
    _project: string,
    _targetBranch: string,
    _sourceBranch: string,
    _title: string,
    _description: string
  ): Promise<never> {
    // TODO: POST /api/v4/projects/:id/merge_requests
    throw new Error('GitLabProvider.createPullRequest() not implemented');
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Create an issue in a project
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {{title: string, body?: string}} issue - Issue details
   * @returns {Promise<{id: string, iid: number, url: string}>}
   */
  async createIssue(
    _group: string,
    _project: string,
    _issue: { title: string; body?: string }
  ): Promise<never> {
    // TODO: POST /api/v4/projects/:id/issues
    throw new Error('GitLabProvider.createIssue() not implemented');
  }

  async findIssueByTitle(_group: string, _project: string, _title: string): Promise<never> {
    // TODO: GET /api/v4/projects/:id/issues?search=...
    throw new Error('GitLabProvider.findIssueByTitle() not implemented');
  }

  /**
   * Add assignees to an issue
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {number} issueIid - Issue IID (internal ID)
   * @param {string[]} assignees - Array of usernames
   */
  async addIssueAssignees(
    _group: string,
    _project: string,
    _issueIid: number,
    _assignees: string[]
  ): Promise<never> {
    // TODO: PUT /api/v4/projects/:id/issues/:issue_iid with assignee_ids
    throw new Error('GitLabProvider.addIssueAssignees() not implemented');
  }

  /**
   * Remove assignees from an issue
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {number} issueIid - Issue IID
   * @param {string[]} assignees - Array of usernames to remove
   */
  async removeIssueAssignees(
    _group: string,
    _project: string,
    _issueIid: number,
    _assignees: string[]
  ): Promise<never> {
    // TODO: PUT /api/v4/projects/:id/issues/:issue_iid with updated assignee_ids
    throw new Error('GitLabProvider.removeIssueAssignees() not implemented');
  }

  // ─── Group (Organization equivalent) ──────────────────────────────────────

  /**
   * Get group details
   * @param {string} group - Group path
   * @returns {Promise<Object>}
   */
  async getOrganization(_group: string): Promise<never> {
    // TODO: GET /api/v4/groups/:id
    throw new Error('GitLabProvider.getOrganization() not implemented');
  }

  /**
   * Get group members
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getOrganizationMembers(_group: string): Promise<never> {
    // TODO: GET /api/v4/groups/:id/members
    throw new Error('GitLabProvider.getOrganizationMembers() not implemented');
  }

  /**
   * Get pending group invitations
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getPendingInvitations(_group: string): Promise<never> {
    // TODO: GET /api/v4/groups/:id/invitations
    throw new Error('GitLabProvider.getPendingInvitations() not implemented');
  }

  /**
   * Cancel a pending invitation
   * @param {string} group - Group path
   * @param {string} email - Invited user's email
   */
  async cancelPendingInvitation(_group: string, _email: string): Promise<never> {
    // TODO: DELETE /api/v4/groups/:id/invitations/:email
    throw new Error('GitLabProvider.cancelPendingInvitation() not implemented');
  }

  /**
   * Invite a user to a group.
   *
   * An email address goes through `/invitations`, which mails a join link to
   * someone who may not have an account yet. A username is added straight to
   * `/members`, which needs the numeric user id.
   *
   * @param {string} group - Group path
   * @param {string} userIdOrEmail - Username or email address
   * @param {number[]} [subgroupIds] - Array of subgroup IDs (unused on GitLab)
   * @param {number} [accessLevel] - GitLab access level (default: Reporter)
   */
  async inviteToOrganization(
    group: string,
    userIdOrEmail: string,
    _subgroupIds?: number[],
    accessLevel: number = REPORTER_ACCESS_LEVEL
  ): Promise<void> {
    const groupId = await this.resolveGroupId(group);

    if (userIdOrEmail.includes('@')) {
      await this.api(`/api/v4/groups/${groupId}/invitations`, {
        method: 'POST',
        body: { email: userIdOrEmail, access_level: accessLevel },
      });
      return;
    }

    const userId = await this.resolveUserId(userIdOrEmail);
    if (userId === null) {
      throw new Error(`GitLab user not found: ${userIdOrEmail}`);
    }

    await this.api(`/api/v4/groups/${groupId}/members`, {
      method: 'POST',
      body: { user_id: userId, access_level: accessLevel },
    });
  }

  /**
   * Remove user from group
   * @param {string} group - Group path
   * @param {string} username - GitLab username
   */
  async removeFromOrganization(_group: string, _username: string): Promise<never> {
    // TODO: DELETE /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.removeFromOrganization() not implemented');
  }

  /**
   * Check if user is a member of the group
   * @param {string} group - Group path
   * @param {string} username - GitLab username
   * @returns {Promise<boolean>}
   */
  async isUserMemberOfOrganization(_group: string, _username: string): Promise<never> {
    // TODO: GET /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.isUserMemberOfOrganization() not implemented');
  }

  /**
   * Get a user by their username
   * @param {string} username - GitLab username
   * @returns {Promise<Object>}
   */
  async getUserByLogin(username: string): Promise<{ id: number; username: string } | null> {
    const users = (await this.api(
      `/api/v4/users?username=${encodeURIComponent(username)}`
    )) as Array<{ id: number; username: string }>;
    return users.length > 0 ? users[0] : null;
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  /**
   * List the groups this token can administer, for the org-picker.
   * Maintainer (40) is the floor because anything less cannot create projects.
   * @returns {Promise<Array<{id: number, full_path: string, name: string, avatar_url: string|null}>>}
   */
  async listGroups(): Promise<
    Array<{ id: number; full_path: string; name: string; avatar_url: string | null }>
  > {
    const groups = (await this.api(
      '/api/v4/groups?min_access_level=40&per_page=100&order_by=path&sort=asc'
    )) as Array<{
      id: number;
      full_path: string;
      name: string;
      avatar_url: string | null;
    }>;

    return groups.map(g => ({
      id: g.id,
      full_path: g.full_path,
      name: g.name,
      avatar_url: g.avatar_url ?? null,
    }));
  }

  // ─── Subgroups (Team equivalent) ──────────────────────────────────────────

  /**
   * Create a subgroup (equivalent to GitHub team)
   * @param {string} group - Parent group path
   * @param {string} name - Subgroup name
   * @returns {Promise<{id: number, path: string, name: string}>}
   */
  async createTeam(
    group: string,
    name: string
  ): Promise<{ id: number; slug: string; name: string }> {
    const parentId = await this.resolveGroupId(group);
    const path = toPath(name);

    const { ok, status, body } = await this.request('/api/v4/groups', {
      method: 'POST',
      body: { name, path, parent_id: parentId, visibility: 'private' },
    });

    if (ok) {
      const created = body as { id: number; path: string; name: string };
      return { id: created.id, slug: created.path, name: created.name };
    }

    // A taken path means the subgroup already exists — adopt it rather than
    // fail, so provisioning can be re-run safely.
    const message =
      body && typeof body === 'object' && 'message' in body
        ? JSON.stringify((body as { message: unknown }).message)
        : String(body ?? '');
    if (status === 400 && message.includes('has already been taken')) {
      return this.getTeam(group, path);
    }

    throw new Error(`GitLab API POST /api/v4/groups failed (${status}): ${message}`);
  }

  /**
   * Get a subgroup by path
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @returns {Promise<{id: number, path: string, name: string}>}
   */
  async getTeam(
    group: string,
    subgroupPath: string
  ): Promise<{ id: number; slug: string; name: string }> {
    const subgroup = (await this.api(
      `/api/v4/groups/${encodeURIComponent(`${group}/${subgroupPath}`)}`
    )) as { id: number; path: string; name: string };
    return { id: subgroup.id, slug: subgroup.path, name: subgroup.name };
  }

  /**
   * Get all subgroups in group
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getTeams(_group: string): Promise<never> {
    // TODO: GET /api/v4/groups/:id/subgroups
    throw new Error('GitLabProvider.getTeams() not implemented');
  }

  /**
   * Delete a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   */
  async deleteTeam(_group: string, _subgroupPath: string): Promise<never> {
    // TODO: DELETE /api/v4/groups/:id
    throw new Error('GitLabProvider.deleteTeam() not implemented');
  }

  /**
   * Add a member to a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @param {string} username - GitLab username
   */
  async addTeamMember(_group: string, _subgroupPath: string, _username: string): Promise<never> {
    // TODO: POST /api/v4/groups/:id/members
    throw new Error('GitLabProvider.addTeamMember() not implemented');
  }

  /**
   * Remove a member from a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @param {string} username - GitLab username
   */
  async removeTeamMember(_group: string, _subgroupPath: string, _username: string): Promise<never> {
    // TODO: DELETE /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.removeTeamMember() not implemented');
  }

  /**
   * Share project with a group (team permission to repo)
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} shareWithGroup - Group to share with
   * @param {string} permission - Access level (guest, reporter, developer, maintainer)
   */
  async addTeamToRepo(
    _group: string,
    _project: string,
    _shareWithGroup: string,
    _permission: string
  ): Promise<never> {
    // TODO: POST /api/v4/projects/:id/share
    throw new Error('GitLabProvider.addTeamToRepo() not implemented');
  }

  // ─── Collaborators ────────────────────────────────────────────────────────

  /**
   * Add a member to a project
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} username - GitLab username
   * @param {string} permission - Access level (default: maintainer)
   */
  async addCollaborator(
    group: string,
    project: string,
    username: string,
    permission: string = 'maintainer'
  ): Promise<void> {
    const accessLevel = ACCESS_LEVELS[permission.toLowerCase()];
    if (accessLevel === undefined) {
      throw new Error(`Unknown GitLab permission: ${permission}`);
    }

    const userId = await this.resolveUserId(username);
    if (userId === null) {
      throw new Error(`GitLab user not found: ${username}`);
    }

    await this.api(`/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/members`, {
      method: 'POST',
      body: { user_id: userId, access_level: accessLevel },
    });
  }

  // ─── GitLab Pages ─────────────────────────────────────────────────────────

  /**
   * GitLab Pages is enabled via .gitlab-ci.yml, not API
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch to serve pages from
   * @returns {Promise<{alreadyEnabled?: boolean}>}
   */
  async enableGitHubPages(
    _group: string,
    _project: string,
    _branch: string = 'main'
  ): Promise<never> {
    // GitLab Pages requires CI/CD configuration, not API call
    // TODO: Check if pages job exists in .gitlab-ci.yml
    throw new Error(
      'GitLabProvider.enableGitHubPages() not implemented - GitLab uses CI/CD for Pages'
    );
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  /**
   * Verify a GitLab webhook signature
   * @param {string} payload - Raw request body
   * @param {string} token - X-Gitlab-Token header value
   * @returns {boolean}
   */
  verifyWebhook(_payload: string, _token: string): never {
    // TODO: Compare token with stored webhook secret
    throw new Error('GitLabProvider.verifyWebhook() not implemented');
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Get clone URL with authentication token
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} token - Access token
   * @returns {string}
   */
  getCloneUrl(group: string, project: string, token: string): string {
    // GitLab clone URL format
    return `https://oauth2:${token}@gitlab.com/${group}/${project}.git`;
  }
}
