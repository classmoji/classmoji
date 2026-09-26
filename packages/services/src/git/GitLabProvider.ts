import { GitProvider } from './GitProvider.ts';
import type { GitIssue, GitRepository } from './GitProvider.ts';
import type {
  CommitRecord,
  ContributorRecord,
  LanguagesMap,
  PRSummary,
} from '../classmoji/repoAnalytics.types.ts';
import { defaultHost } from '../classmoji/gitlabInstance.service.ts';

/**
 * The author of commits Classmoji makes in student projects (CI config, etc.).
 * Same address as CLASSMOJI_BOT_EMAIL, which push handling treats as not a
 * student's work.
 */
const CLASSMOJI_BOT_AUTHOR_EMAIL = 'hello@classmoji.com';

/** The name Classmoji gives its project hooks, so they can be found again. */
const CLASSMOJI_HOOK_NAME = 'Classmoji';

/** hook-station's GitLab callback, with or without the old per-instance segment. */
const CLASSMOJI_HOOK_PATH = /\/webhooks\/callback\/gitlab(\/[0-9a-f-]{36})?\/?$/i;

/**
 * A project hook Classmoji made: its name, its current URL, a URL at
 * hook-station's GitLab path, or a smee relay (local development).
 */
function isClassmojiHook(hook: { url: string; name?: string | null }, url: string): boolean {
  if (hook.url === url || hook.name === CLASSMOJI_HOOK_NAME) return true;
  try {
    const parsed = new URL(hook.url);
    return CLASSMOJI_HOOK_PATH.test(parsed.pathname) || parsed.hostname === 'smee.io';
  } catch {
    return false;
  }
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
  /** The instance's origin, e.g. `https://gitlab.com` or a school's GitLab. */
  baseUrl: string;
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
   * @param {string} [baseUrl] - The instance's origin; the default instance when omitted
   */
  constructor(
    groupId: string,
    groupPath: string | null = null,
    token: string | null | (() => Promise<string>) = null,
    baseUrl: string | null = null
  ) {
    super({ groupId, groupPath });
    this.groupId = groupId;
    this.groupPath = groupPath;
    this.baseUrl = (baseUrl || defaultHost()).replace(/\/+$/, '');
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

    const res = await fetch(`${this.baseUrl}${path}`, options);
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

  /**
   * A raw authenticated call, for the few endpoints whose answer is not JSON
   * (raw blob bytes) or lives in headers (file metadata on HEAD, pagination).
   * Never throws on a status; the caller reads `res.status`.
   */
  async fetchRaw(path: string, init: { method?: string } = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    return fetch(url, {
      method: init.method || 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /**
   * Every page of a list endpoint. Follows the `Link: rel="next"` header, which
   * both offset and keyset pagination send, so a caller can ask for keyset
   * (required past 50k offset rows on large trees) without changing this.
   */
  async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next) {
      const res = await this.fetchRaw(next);
      if (!res.ok) {
        const error = new Error(
          `Gitlab API GET ${next} failed (${res.status}): ${await res.text()}`
        ) as Error & { status: number };
        error.status = res.status;
        throw error;
      }
      items.push(...((await res.json()) as T[]));
      const link = res.headers.get('link') ?? '';
      const match = link.split(',').find(part => /rel="next"/.test(part));
      next = match ? (match.match(/<([^>]+)>/)?.[1] ?? null) : null;
    }
    return items;
  }

  /** `/api/v4/projects/:id` for a project by group path + project path. */
  projectApi(group: string, project: string): string {
    return `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`;
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
    group: string,
    name: string,
    description: string = '',
    isPrivate: boolean = true
  ): Promise<GitRepository> {
    const namespaceId = await this.resolveGroupId(group);
    // Initialized with a README, like Github's auto_init, so the default
    // branch exists before the first content write. Displayed as "Content":
    // it sits in the class subgroup, so the class name in the path (kept
    // unique per top group, as content lookups need) is noise on screen.
    const project = (await this.api('/api/v4/projects', {
      method: 'POST',
      body: {
        name: 'Content',
        path: toPath(name),
        namespace_id: namespaceId,
        description,
        visibility: isPrivate ? 'private' : 'public',
        initialize_with_readme: true,
        default_branch: 'main',
      },
    })) as { id: number; path: string; web_url: string };
    return { id: String(project.id), name: project.path, url: project.web_url };
  }

  /**
   * Check if project exists
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @returns {Promise<boolean>}
   */
  async repositoryExists(group: string, name: string): Promise<boolean> {
    const { ok, status } = await this.request(this.projectApi(group, name));
    if (ok) return true;
    if (status === 404) return false;
    throw Object.assign(new Error(`Gitlab project lookup failed (${status})`), { status });
  }

  /**
   * Delete a project
   * @param {string} group - Group path
   * @param {string} name - Project name
   */
  async deleteRepository(group: string, name: string): Promise<void> {
    await this.api(this.projectApi(group, name), { method: 'DELETE' });
  }

  /** The project's default branch. */
  async getDefaultBranch(group: string, project: string): Promise<string> {
    const body = (await this.api(this.projectApi(group, project))) as {
      default_branch: string | null;
    };
    return body.default_branch || 'main';
  }

  /**
   * Every path in the project and the git object behind it. GitLab's tree ids
   * are real git object ids, so the entries match Github's tree listing; the
   * listing carries no sizes. Never truncated: every page is followed.
   */
  async getTree(
    group: string,
    project: string,
    ref: string,
    recursive: boolean = true
  ): Promise<{
    sha: string;
    truncated: boolean;
    entries: { path: string; sha: string; type: string; size?: number }[];
  }> {
    const params = new URLSearchParams({
      ref,
      per_page: '100',
      pagination: 'keyset',
      ...(recursive ? { recursive: 'true' } : {}),
    });
    const items = await this.paginate<{ id: string; path: string; type: string }>(
      `${this.projectApi(group, project)}/repository/tree?${params.toString()}`
    );
    return {
      sha: ref,
      truncated: false,
      entries: items
        .filter(item => item.type === 'blob' || item.type === 'tree')
        .map(item => ({ path: item.path, sha: item.id, type: item.type })),
    };
  }

  /**
   * A token to hand to someone else (the content Worker). Never the
   * connection's own OAuth token, which can write to everything its user can:
   * for exactly one project (`scope.repositories`), a Reporter project access
   * token with `read_api`, the counterpart of Github's down-scoped
   * installation token. Gitlab dates expire at day granularity, so it is kept
   * for a day and handed out as good for less.
   */
  async getInstallationToken(scope?: {
    repositories?: string[];
    permissions?: Record<string, string>;
  }): Promise<{ token: string; expiresAt: string }> {
    const repo = scope?.repositories?.length === 1 ? scope.repositories[0] : null;
    if (!repo || !this.groupPath) {
      throw new Error('Gitlab tokens are only handed out for a single project');
    }
    const key = `${this.groupPath}/${repo}`;
    const cached = GitLabProvider.#projectTokens.get(key);
    if (cached && Date.now() < cached.handOutUntil) {
      return { token: cached.token, expiresAt: new Date(cached.handOutUntil).toISOString() };
    }

    const expiresOn = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const minted = (await this.api(`${this.projectApi(this.groupPath, repo)}/access_tokens`, {
      method: 'POST',
      body: {
        name: 'classmoji-content-delivery',
        scopes: ['read_api'],
        access_level: REPORTER_ACCESS_LEVEL,
        expires_at: expiresOn,
      },
    })) as { token: string };

    const handOutUntil = Date.now() + 20 * 60 * 60 * 1000;
    GitLabProvider.#projectTokens.set(key, { token: minted.token, handOutUntil });
    return { token: minted.token, expiresAt: new Date(handOutUntil).toISOString() };
  }

  /** Minted read-only project tokens, per `group/project`, for this process. */
  static #projectTokens = new Map<string, { token: string; handOutUntil: number }>();

  // ─── Branches & Merge Requests ────────────────────────────────────────────

  /**
   * Get the latest commit SHA for a branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch name (default: main)
   * @returns {Promise<string>} Commit SHA
   */
  async getLatestCommitSHA(
    group: string,
    project: string,
    branch: string = 'main'
  ): Promise<string> {
    const body = (await this.api(
      `${this.projectApi(group, project)}/repository/branches/${encodeURIComponent(branch)}`
    )) as { commit: { id: string } };
    return body.commit.id;
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
   * The state of a project's Classmoji webhook: missing, `failing` when GitLab
   * has disabled it (temporarily or for good) after failed deliveries, else ok.
   */
  async getClassmojiHookStatus(
    group: string,
    project: string,
    url: string
  ): Promise<'ok' | 'missing' | 'failing'> {
    const hooks = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/hooks`
    )) as Array<{ url: string; name?: string | null; alert_status?: string }>;
    const ours = hooks.filter(h => isClassmojiHook(h, url));
    if (ours.length === 0) return 'missing';
    return ours.some(h => h.alert_status && h.alert_status !== 'executable') ? 'failing' : 'ok';
  }

  /**
   * Pushes to a project's default branch after `since`, oldest first, with
   * GitLab's server-side time and the pusher's username. For catching up on
   * pushes whose webhook never arrived (a GitLab that can't reach Classmoji).
   * Branch deletions are left out.
   */
  async listDefaultBranchPushes(
    group: string,
    project: string,
    since: Date | null
  ): Promise<Array<{ at: Date; author: string | null; sha: string }>> {
    const path = encodeURIComponent(`${group}/${project}`);
    const meta = (await this.api(`/api/v4/projects/${path}`)) as { default_branch?: string | null };
    const branch = meta.default_branch;
    if (!branch) return [];
    // `after` is a date (exclusive), so step back a day and filter precisely.
    const after = since
      ? `&after=${new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10)}`
      : '';
    const events = (await this.api(
      `/api/v4/projects/${path}/events?action=pushed&per_page=100${after}`
    )) as Array<{
      created_at?: string;
      author_username?: string;
      push_data?: { ref?: string; ref_type?: string; action?: string; commit_to?: string | null };
    }>;
    return events
      .filter(
        e =>
          e.push_data?.ref_type === 'branch' &&
          e.push_data.ref === branch &&
          e.push_data.action !== 'removed' &&
          e.push_data.commit_to &&
          e.created_at
      )
      .map(e => ({
        at: new Date(e.created_at as string),
        author: e.author_username ?? null,
        sha: e.push_data?.commit_to as string,
      }))
      .filter(e => !Number.isNaN(e.at.getTime()) && (!since || e.at > since))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /**
   * When GitLab received the push that moved a project's branch to `sha`, from
   * its events API (server-set, unlike commit dates, which are the author's
   * clock). Null when the event can't be found.
   */
  async getPushTime(group: string, project: string, sha: string): Promise<Date | null> {
    const events = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/events?action=pushed&per_page=50`
    )) as Array<{ created_at?: string; push_data?: { commit_to?: string | null } }>;
    const match = events.find(e => e.push_data?.commit_to === sha);
    const time = match?.created_at ? new Date(match.created_at) : null;
    return time && !Number.isNaN(time.getTime()) ? time : null;
  }

  /**
   * Make sure a project has exactly one Classmoji webhook, pointing at `url`
   * with `secret` as its token, for pushes and issue events. Project hooks are
   * free on gitlab.com; group hooks need a paid plan.
   *
   * Self-healing, because a hook can go bad without anyone noticing:
   *  - GitLab wipes a hook's secret token when its URL is changed, and the
   *    token can't be read back, so the token is always re-set.
   *  - A hook left on an older Classmoji URL (a moved hook-station, an old
   *    per-instance path, a rotated smee channel) is found and repointed
   *    rather than a second one added. Duplicates are removed.
   *  - Updating a hook re-enables one GitLab disabled after failed deliveries.
   */
  async ensureProjectPushHook(
    group: string,
    project: string,
    url: string,
    secret: string
  ): Promise<'created' | 'updated'> {
    const base = `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/hooks`;
    const hooks = (await this.api(base)) as Array<{
      id: number;
      url: string;
      name?: string | null;
    }>;
    const ours = hooks
      .filter(h => isClassmojiHook(h, url))
      // Keep the one already on the right URL, if any.
      .sort((a, b) => Number(b.url === url) - Number(a.url === url));
    const body = {
      url,
      token: secret,
      name: CLASSMOJI_HOOK_NAME,
      push_events: true,
      issues_events: true,
      enable_ssl_verification: true,
    };

    if (ours.length === 0) {
      await this.api(base, { method: 'POST', body });
      return 'created';
    }
    const [keep, ...duplicates] = ours;
    await this.api(`${base}/${keep.id}`, { method: 'PUT', body });
    for (const duplicate of duplicates) {
      await this.api(`${base}/${duplicate.id}`, { method: 'DELETE' });
    }
    return 'updated';
  }

  /**
   * Per-author totals on the default branch. GitLab groups contributors by
   * name/email and exposes no username here, so `login` carries the author
   * name and `user_id` stays null (the snapshot's linker leaves it unmatched).
   */
  async getContributorStats(group: string, project: string): Promise<ContributorRecord[]> {
    const contributors = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/repository/contributors?per_page=100`
    )) as Array<{
      name: string;
      email: string;
      commits: number;
      additions: number;
      deletions: number;
    }>;
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
  async createBranch(group: string, project: string, branch: string, sha: string): Promise<void> {
    await this.api(`${this.projectApi(group, project)}/repository/branches`, {
      method: 'POST',
      body: { branch, ref: sha },
    });
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

  /**
   * Move a project into another group (e.g. a content project into its class
   * subgroup). GitLab keeps redirects from the old path.
   */
  async transferProject(group: string, project: string, toNamespace: string): Promise<void> {
    await this.api(`/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/transfer`, {
      method: 'PUT',
      body: { namespace: toNamespace },
    });
  }

  /** Set a project's display name only; its path (and every URL) stays. */
  async setProjectDisplayName(group: string, project: string, name: string): Promise<void> {
    await this.api(`/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`, {
      method: 'PUT',
      body: { name },
    });
  }

  /** Whether a project exists at `group/project`. */
  async projectExists(group: string, project: string): Promise<boolean> {
    const { ok } = await this.request(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`
    );
    return ok;
  }

  /** An open merge request from `source` into `target`, if any. */
  async findOpenMergeRequest(
    group: string,
    project: string,
    source: string,
    target: string
  ): Promise<{ iid: number; url: string } | null> {
    const mrs = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/merge_requests?state=opened` +
        `&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`
    )) as Array<{ iid: number; web_url: string }>;
    return mrs[0] ? { iid: mrs[0].iid, url: mrs[0].web_url } : null;
  }

  /** Retitle / re-describe a merge request. */
  async updateMergeRequest(
    group: string,
    project: string,
    iid: number,
    title: string,
    description: string
  ): Promise<{ url: string }> {
    const mr = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/merge_requests/${iid}`,
      { method: 'PUT', body: { title, description } }
    )) as { web_url: string };
    return { url: mr.web_url };
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
  //
  // A GitLab classroom's teams are subgroups of `<class subgroup>/teams`, the
  // `group` every method below receives (see gitlabTeamsNamespace in
  // @classmoji/utils). Members are Developers of their team subgroup, and each
  // team project is shared with it, so a membership change reaches every
  // project of the team at once, like a Github team.

  /**
   * Create a team subgroup under `group`, creating `group` itself (the class's
   * `teams` subgroup) the first time. A taken path adopts the existing team.
   */
  async createTeam(
    group: string,
    name: string
  ): Promise<{ id: number; slug: string; name: string }> {
    let parentId: number;
    try {
      parentId = await this.resolveGroupId(group);
    } catch (error: unknown) {
      const at = group.lastIndexOf('/');
      if ((error as { status?: number }).status !== 404 || at === -1) throw error;
      const parent = group.slice(0, at);
      const path = group.slice(at + 1);
      parentId = (await this.createSubgroup(parent, 'Teams', path)).id;
    }
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
    if ((status === 400 || status === 422) && message.includes('has already been taken')) {
      return this.getTeam(group, path);
    }

    throw new Error(`Gitlab API POST /api/v4/groups failed (${status}): ${message}`);
  }

  /** A team subgroup by path. Throws with `.status` 404 when missing. */
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
   * Rename a team subgroup; its path follows the name, like a GitHub team's
   * slug. Returns the new slug (path) and name.
   */
  async updateTeam(
    group: string,
    subgroupPath: string,
    changes: { name: string }
  ): Promise<{ id: number; slug: string; name: string }> {
    const updated = (await this.api(
      `/api/v4/groups/${encodeURIComponent(`${group}/${subgroupPath}`)}`,
      { method: 'PUT', body: { name: changes.name, path: toPath(changes.name) } }
    )) as { id: number; path: string; name: string };
    return { id: updated.id, slug: updated.path, name: updated.name };
  }

  /**
   * Rename a project (name and path together, so its URL matches). GitLab
   * redirects the old path, so existing clones keep working.
   */
  async updateRepo(
    group: string,
    project: string,
    changes: { name: string }
  ): Promise<{ name: string }> {
    const updated = (await this.api(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`,
      { method: 'PUT', body: { name: changes.name, path: toPath(changes.name) } }
    )) as { path: string };
    return { name: updated.path };
  }

  /** Every team subgroup under `group` (none when `group` doesn't exist yet). */
  async getTeams(group: string): Promise<Array<{ id: number; slug: string; name: string }>> {
    const { ok, status, body } = await this.request(
      `/api/v4/groups/${encodeURIComponent(group)}/subgroups?per_page=100`
    );
    if (!ok) {
      if (status === 404) return [];
      throw new Error(`Gitlab API GET subgroups failed (${status})`);
    }
    return (body as Array<{ id: number; path: string; name: string }>).map(g => ({
      id: g.id,
      slug: g.path,
      name: g.name,
    }));
  }

  /** Delete a team subgroup. Already gone is fine. */
  async deleteTeam(group: string, subgroupPath: string): Promise<void> {
    const { ok, status } = await this.request(
      `/api/v4/groups/${encodeURIComponent(`${group}/${subgroupPath}`)}`,
      { method: 'DELETE' }
    );
    if (!ok && status !== 404) {
      throw new Error(`Gitlab API DELETE group failed (${status})`);
    }
  }

  /** Add a member to a team subgroup, as Developer. */
  async addTeamMember(group: string, subgroupPath: string, username: string): Promise<void> {
    await this.addGroupMember(`${group}/${subgroupPath}`, username, ACCESS_LEVELS.developer);
  }

  /** Remove a member from a team subgroup. Not a member is fine. */
  async removeTeamMember(group: string, subgroupPath: string, username: string): Promise<void> {
    await this.removeGroupMember(`${group}/${subgroupPath}`, username);
  }

  /**
   * Share a project with a team subgroup, so its members get `permission` on
   * it (Developer for students; the project's default branch already lets
   * Developers push). `shareWithGroup` is the team subgroup's full path.
   * Already shared is fine.
   */
  async addTeamToRepo(
    group: string,
    project: string,
    shareWithGroup: string,
    permission: string
  ): Promise<void> {
    const groupId = await this.resolveGroupId(shareWithGroup);
    const level = ACCESS_LEVELS[permission] ?? ACCESS_LEVELS.developer;
    const { ok, status, body } = await this.request(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/share`,
      { method: 'POST', body: { group_id: groupId, group_access: level } }
    );
    if (ok) return;
    const message = JSON.stringify(body ?? '');
    if (status === 409 || message.includes('already')) return;
    throw new Error(`Gitlab API POST project share failed (${status}): ${message}`);
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

  /**
   * Write one file on the project's default branch, committed as the
   * Classmoji bot (so hook-station can tell the commit isn't a student's).
   * Creates the file, or updates it when it exists; unchanged content is a
   * no-op. Same contract as GitHubProvider.putFile.
   */
  async putFile(
    group: string,
    project: string,
    path: string,
    content: string,
    message: string
  ): Promise<{ commit: string; unchanged?: boolean }> {
    const projectPath = `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}`;
    const meta = (await this.api(projectPath)) as { default_branch?: string | null };
    const branch = meta.default_branch || 'main';

    const existing = await this.request(
      `${projectPath}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`
    );
    if (existing.ok) {
      const current = existing.body as {
        content?: string;
        encoding?: string;
        last_commit_id?: string;
      };
      const text =
        current.encoding === 'base64'
          ? Buffer.from(current.content ?? '', 'base64').toString('utf8')
          : (current.content ?? '');
      if (text === content) return { commit: current.last_commit_id ?? '', unchanged: true };
    }

    const commit = (await this.api(`${projectPath}/repository/commits`, {
      method: 'POST',
      body: {
        branch,
        commit_message: message,
        author_name: 'Classmoji',
        author_email: CLASSMOJI_BOT_AUTHOR_EMAIL,
        actions: [{ action: existing.ok ? 'update' : 'create', file_path: path, content }],
      },
    })) as { id: string };
    return { commit: commit.id };
  }

  /**
   * Change a direct project member's access (e.g. to Reporter, read-only, when
   * a student leaves the class). Not a member, or no such user, is fine.
   */
  async setProjectMemberAccess(
    group: string,
    project: string,
    username: string,
    permission: string
  ): Promise<void> {
    const accessLevel = ACCESS_LEVELS[permission.toLowerCase()];
    if (accessLevel === undefined) throw new Error(`Unknown Gitlab permission: ${permission}`);
    const userId = await this.resolveUserId(username);
    if (userId === null) return;
    const { ok, status, body } = await this.request(
      `/api/v4/projects/${encodeURIComponent(`${group}/${project}`)}/members/${userId}`,
      { method: 'PUT', body: { access_level: accessLevel } }
    );
    if (ok || status === 404) return;
    throw new Error(
      `Gitlab API PUT project member failed (${status}): ${JSON.stringify(body ?? '')}`
    );
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
    const host = this.baseUrl.replace(/^https?:\/\//, '');
    return `https://oauth2:${token}@${host}/${group}/${project}.git`;
  }
}
