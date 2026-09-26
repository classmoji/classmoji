import { GitProvider } from './GitProvider.ts';
import type { GitIssue, GitRepository } from './GitProvider.ts';
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
  #token: string | null | (() => Promise<string>);

  /**
   * @param {string} groupId - GitLab Group ID
   * @param {string} [groupPath] - Group path/slug (optional)
   * @param {string | () => Promise<string>} [token] - GitLab access token, or a
   *   function returning a current one (a GitLab connection, refreshed per call)
   */
  constructor(
    groupId: string,
    groupPath: string | null = null,
    token: string | null | (() => Promise<string>) = null
  ) {
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
    const token = await this.getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
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

  /**
   * {@link GitLabProvider.request}, but throws on a non-2xx response.
   *
   * The error carries `status`, like Octokit's, because shared callers branch
   * on it (`ensureClassroomTeam` creates on 404, `createRepository` adopts on
   * 422). GitLab reports a taken name as 400 "has already been taken"; that is
   * surfaced as 422, Github's status for the same condition.
   */
  async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const { ok, status, body } = await this.request(path, init);
    if (!ok) {
      const message =
        body && typeof body === 'object' && 'message' in body
          ? JSON.stringify((body as { message: unknown }).message)
          : String(body ?? '');
      const error = new Error(
        `Gitlab API ${init.method || 'GET'} ${path} failed (${status}): ${message}`
      ) as Error & { status: number };
      error.status = status === 400 && message.includes('has already been taken') ? 422 : status;
      throw error;
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
  async getAccessToken(): Promise<string> {
    if (!this.#token) {
      throw new Error('GitLabProvider requires an access token for API calls');
    }
    return typeof this.#token === 'function' ? this.#token() : this.#token;
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
  async createContentRepository(
    _group: string,
    _name: string,
    _description: string = '',
    _isPrivate: boolean = true
  ): Promise<never> {
    // TODO: POST /api/v4/projects with visibility per _isPrivate
    throw new Error('GitLabProvider.createContentRepository() not implemented');
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

  /**
   * Recent commits, newest first. GitLab exposes no author username on a
   * commit, only name and email, so `author_login` is null.
   */
  async listCommits(
    group: string,
    project: string,
    opts: { since?: string; branch?: string; maxCommits?: number } = {}
  ): Promise<CommitRecord[]> {
    const params = new URLSearchParams({
      per_page: String(Math.min(opts.maxCommits ?? 100, 100)),
      with_stats: 'true',
    });
    if (opts.branch) params.set('ref_name', opts.branch);
    if (opts.since) params.set('since', opts.since);
    const commits = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/repository/commits?${params.toString()}`
    )) as Array<{
      id: string;
      author_email: string | null;
      committed_date: string;
      message: string;
      parent_ids: string[];
      stats?: { additions: number; deletions: number };
    }>;
    return commits.map(c => ({
      sha: c.id,
      author_login: null,
      author_email: c.author_email ?? null,
      author_user_id: null,
      ts: c.committed_date,
      message: c.message,
      additions: c.stats?.additions ?? 0,
      deletions: c.stats?.deletions ?? 0,
      parents: c.parent_ids ?? [],
    }));
  }

  /**
   * Let Developers push to (and merge into) `branch`, keeping it protected
   * against force-pushes and deletion. gitlab.com protects the default branch
   * for Maintainers only, and students are Developers on their own project
   * (a Maintainer could remove Classmoji's webhook), so without this a
   * student could never push to `main`.
   */
  async allowDeveloperPushes(group: string, project: string, branch: string): Promise<void> {
    const base = `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/protected_branches`;
    // Re-protecting is the free-plan way to change the access levels.
    const { ok, status } = await this.request(`${base}/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
    });
    if (!ok && status !== 404) {
      throw new Error(`Gitlab API DELETE protected branch ${branch} failed (${status})`);
    }
    await this.api(base, {
      method: 'POST',
      body: {
        name: branch,
        push_access_level: 30,
        merge_access_level: 30,
        allow_force_push: false,
      },
    });
  }

  /**
   * Create a private project seeded with one README commit on `main`, the way
   * a blank template needs a root commit for student copies to start from.
   */
  async createProjectWithReadme(
    namespace: string,
    name: string,
    readme: string,
    message: string
  ): Promise<GitRepository> {
    const project = await this.createRepository(namespace, name);
    await this.api(`/api/v4/projects/${project.id}/repository/commits`, {
      method: 'POST',
      body: {
        branch: 'main',
        commit_message: message,
        actions: [{ action: 'create', file_path: 'README.md', content: readme }],
      },
    });
    return project;
  }

  /**
   * Add a push webhook to a project, unless one for `url` exists already.
   * Project hooks are free on gitlab.com; group hooks need a paid plan.
   */
  async ensureProjectPushHook(
    group: string,
    project: string,
    url: string,
    secret: string
  ): Promise<void> {
    const base = `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/hooks`;
    const hooks = (await this.api(base)) as Array<{
      id: number;
      url: string;
      issues_events?: boolean;
    }>;
    const existing = hooks.find(h => h.url === url);
    // Pushes are REPO-mode submissions; issue close/reopen are ISSUE-mode ones.
    if (existing) {
      if (!existing.issues_events) {
        await this.api(`${base}/${existing.id}`, {
          method: 'PUT',
          body: { url, token: secret, push_events: true, issues_events: true },
        });
      }
      return;
    }
    await this.api(base, {
      method: 'POST',
      body: {
        url,
        token: secret,
        push_events: true,
        issues_events: true,
        enable_ssl_verification: true,
      },
    });
  }

  /**
   * Per-author totals on the default branch. GitLab groups contributors by
   * name/email and exposes no username here, so `login` carries the author
   * name and `user_id` stays null (the snapshot's linker leaves it unmatched).
   */
  async getContributorStats(group: string, project: string): Promise<ContributorRecord[]> {
    const contributors = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/repository/contributors?per_page=100`
    )) as Array<{ name: string; email: string; commits: number; additions: number; deletions: number }>;
    return contributors.map(c => ({
      login: c.name || c.email,
      user_id: null,
      commits: c.commits ?? 0,
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
    }));
  }

  /**
   * Languages by share. GitLab reports percentages where Github reports bytes;
   * both are only ever read as proportions.
   */
  async getLanguages(group: string, project: string): Promise<LanguagesMap> {
    return (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/languages`
    )) as LanguagesMap;
  }

  /** Merge request counts by state (GitLab's pull requests). */
  async listPulls(group: string, project: string): Promise<PRSummary> {
    const mrs = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/merge_requests?state=all&per_page=100`
    )) as Array<{ state: string }>;
    return {
      open: mrs.filter(m => m.state === 'opened').length,
      merged: mrs.filter(m => m.state === 'merged').length,
      closed: mrs.filter(m => m.state === 'closed').length,
    };
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
    group: string,
    project: string,
    targetBranch: string,
    sourceBranch: string,
    title: string,
    description: string
  ): Promise<{ id: number; iid: number; url: string }> {
    // Same argument order as GitHubProvider: (base, head). On GitLab the base
    // is the MR's target and the head its source.
    const mr = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/merge_requests`,
      {
        method: 'POST',
        body: {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title,
          description,
        },
      }
    )) as { id: number; iid: number; web_url: string };
    return { id: mr.id, iid: mr.iid, url: mr.web_url };
  }

  /** A project by group path + project path. */
  async getRepository(group: string, project: string): Promise<GitRepository> {
    const body = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`
    )) as { id: number; path: string; web_url: string };
    return { id: String(body.id), name: body.path, url: body.web_url };
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Create an issue in a project
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {{title: string, body?: string}} issue - Issue details
   * @returns {Promise<{id: string, iid: number, url: string}>}
   */
  /**
   * Open an issue in a project. Returns GitHubProvider's shape: `id` is the
   * issue's global id (what the Issue Hook reports), `number` its per-project
   * iid (what its URL uses).
   */
  async createIssue(
    group: string,
    project: string,
    issue: { title: string; body?: string; description?: string }
  ): Promise<{ id: string; number: number; url: string }> {
    const created = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/issues`,
      {
        method: 'POST',
        body: { title: issue.title, description: issue.body ?? issue.description ?? '' },
      }
    )) as { id: number; iid: number; web_url: string };
    return { id: String(created.id), number: created.iid, url: created.web_url };
  }

  /** An issue whose title is exactly `title`, open or closed, if there is one. */
  async findIssueByTitle(group: string, project: string, title: string): Promise<GitIssue | null> {
    const params = new URLSearchParams({ search: title, in: 'title', per_page: '100' });
    const issues = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/issues?${params.toString()}`
    )) as Array<{ id: number; iid: number; title: string; web_url: string }>;
    const match = issues.find(i => i.title === title);
    return match ? { id: String(match.id), number: match.iid, url: match.web_url } : null;
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
  ): Promise<void> {
    // Deliberately a no-op. On Github, graders are added as issue assignees;
    // GitLab's free plan allows ONE assignee per issue, so there is no room
    // for them. Graders stay tracked in Classmoji (grading page and queue).
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
  ): Promise<void> {
    // No-op: graders are never assigned on GitLab (see addIssueAssignees).
  }

  // ─── Group (Organization equivalent) ──────────────────────────────────────

  /**
   * Get group details
   * @param {string} group - Group path
   * @returns {Promise<Object>}
   */
  async getOrganization(group: string): Promise<{
    id: number;
    login: string;
    name: string;
    plan: { name: string };
  }> {
    const g = await this.getGroup(group);
    // Callers read `plan.name` to decide Github-only paid features (branch
    // protection on private repos). GitLab has no equivalent gate here, so it
    // reports as 'free' and those steps are skipped.
    return { id: g.id, login: g.full_path, name: g.name, plan: { name: 'free' } };
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
      throw new Error(`Gitlab user not found: ${userIdOrEmail}`);
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

  /**
   * A group by path or id, with the caller's own access level on it (null when
   * the token's user is not a member).
   */
  async getGroup(group: string): Promise<{
    id: number;
    full_path: string;
    name: string;
    avatar_url: string | null;
  }> {
    const body = (await this.api(`/api/v4/groups/${encodeURIComponent(group)}`)) as {
      id: number;
      full_path: string;
      name: string;
      avatar_url: string | null;
    };
    return {
      id: body.id,
      full_path: body.full_path,
      name: body.name,
      avatar_url: body.avatar_url ?? null,
    };
  }

  /**
   * Make `username` a member of `group` at `accessLevel`, or move an existing
   * member to that level. Used for a class subgroup's staff: members inherit
   * every student project in it.
   */
  async addGroupMember(group: string, username: string, accessLevel: number): Promise<void> {
    const userId = await this.resolveUserId(username);
    if (userId === null) {
      const error = new Error(`Gitlab user not found: ${username}`) as Error & { status: number };
      error.status = 404;
      throw error;
    }
    const groupPath = encodeURIComponent(group);
    const { ok, status, body } = await this.request(`/api/v4/groups/${groupPath}/members`, {
      method: 'POST',
      body: { user_id: userId, access_level: accessLevel },
    });
    if (ok) return;
    if (status === 409) {
      // Already a member: set the level instead.
      await this.api(`/api/v4/groups/${groupPath}/members/${userId}`, {
        method: 'PUT',
        body: { access_level: accessLevel },
      });
      return;
    }
    // Someone who inherits a higher role from a parent group (e.g. the group
    // Owner) already has at least this access.
    if (JSON.stringify(body ?? '').includes('inherited membership')) return;
    throw new Error(`Gitlab API POST group members failed (${status}): ${JSON.stringify(body)}`);
  }

  /** Remove `username` from `group`. A non-member is a no-op. */
  async removeGroupMember(group: string, username: string): Promise<void> {
    const userId = await this.resolveUserId(username);
    if (userId === null) return;
    const { ok, status, body } = await this.request(
      `/api/v4/groups/${encodeURIComponent(group)}/members/${userId}`,
      { method: 'DELETE' }
    );
    if (!ok && status !== 404) {
      throw new Error(`Gitlab API DELETE group member failed (${status}): ${JSON.stringify(body)}`);
    }
  }

  /**
   * Projects in a group and all its subgroups, most recently active first.
   * Backs the template picker (the counterpart of listing the org's repos).
   */
  async listGroupProjects(
    group: string,
    search = ''
  ): Promise<
    Array<{
      name: string;
      path_with_namespace: string;
      description: string | null;
      last_activity_at: string | null;
      visibility: string;
      star_count: number;
    }>
  > {
    const params = new URLSearchParams({
      include_subgroups: 'true',
      order_by: 'last_activity_at',
      sort: 'desc',
      per_page: '100',
      archived: 'false',
    });
    if (search) params.set('search', search);
    return (await this.api(
      `/api/v4/groups/${encodeURIComponent(group)}/projects?${params.toString()}`
    )) as Array<{
      name: string;
      path_with_namespace: string;
      description: string | null;
      last_activity_at: string | null;
      visibility: string;
      star_count: number;
    }>;
  }

  /**
   * Create a subgroup under `parent` and return its full path. A taken path
   * adopts the existing subgroup, so a retried classroom creation is safe.
   * Used for the per-classroom subgroup that holds a class's student projects.
   */
  async createSubgroup(
    parent: string,
    name: string,
    path: string
  ): Promise<{ id: number; full_path: string }> {
    const parentId = await this.resolveGroupId(parent);
    try {
      const created = (await this.api('/api/v4/groups', {
        method: 'POST',
        body: { name, path, parent_id: parentId, visibility: 'private' },
      })) as { id: number; full_path: string };
      return { id: created.id, full_path: created.full_path };
    } catch (error: unknown) {
      if ((error as { status?: number }).status !== 422) throw error;
      const existing = await this.getGroup(`${parent}/${path}`);
      return { id: existing.id, full_path: existing.full_path };
    }
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

    throw new Error(`Gitlab API POST /api/v4/groups failed (${status}): ${message}`);
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
      throw new Error(`Unknown Gitlab permission: ${permission}`);
    }

    const userId = await this.resolveUserId(username);
    if (userId === null) {
      throw new Error(`Gitlab user not found: ${username}`);
    }

    const { ok, status, body } = await this.request(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/members`,
      { method: 'POST', body: { user_id: userId, access_level: accessLevel } }
    );
    if (ok) return;

    // Already has access: a direct member (409), or someone who inherits a
    // higher role from the group, e.g. an instructor testing as a student
    // ("should be greater than or equal to ... inherited membership").
    const message = JSON.stringify(body ?? '');
    if (status === 409 || message.includes('inherited membership')) return;

    const error = new Error(
      `Gitlab API POST project members failed (${status}): ${message}`
    ) as Error & { status: number };
    error.status = status;
    throw error;
  }

  // ─── GitLab Pages ─────────────────────────────────────────────────────────

  // There is no enable here either: Classmoji never turns on GitLab Pages, the
  // same rule as GitHub Pages.

  /**
   * GitLab Pages state lives in CI/CD, not in an API this adapter speaks
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @returns {Promise<never>}
   */
  async getRepoPages(_group: string, _project: string): Promise<never> {
    throw new Error('GitLabProvider.getRepoPages() not implemented - Gitlab uses CI/CD for Pages');
  }

  /**
   * GitLab Pages is removed by deleting the pages job / its deployment, not by
   * one API call
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @returns {Promise<never>}
   */
  async disableGitHubPages(_group: string, _project: string): Promise<never> {
    // TODO: DELETE /api/v4/projects/:id/pages once a GitLab classroom needs it
    throw new Error(
      'GitLabProvider.disableGitHubPages() not implemented - Gitlab uses CI/CD for Pages'
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
    // GitLab clone URL format, on the configured instance
    const host = gitlabBaseUrl().replace(/^https?:\/\//, '');
    return `https://oauth2:${token}@${host}/${group}/${project}.git`;
  }
}
