/**
 * GitHub organization repository settings — the two org-level defaults the
 * classroom settings page edits:
 *   - default_repository_permission (none | read | write)
 *   - members_can_create_repositories (boolean)
 *
 * Shared by the web settings route (admin.$class.settings.repos) and the MCP
 * tool (org_repo_settings_update), so both apply exactly the same rules:
 *
 *   1. Only the settings this page edits are accepted. The GitHub payload is
 *      built field by field from validated values; unknown keys or values are
 *      refused, never forwarded.
 *   2. The organization is always the one linked to the caller's authorized
 *      classroom (`git_organization.login`), never a value from the request.
 *   3. Changes run with the requesting user's own GitHub token (a GitHub App
 *      user-to-server token), never the app installation token. GitHub then
 *      applies the user's own permissions: only organization owners can change
 *      these settings, and anyone else gets a 403/404 from GitHub, which is
 *      reported as such. There is no installation-token fallback. This is the
 *      same model the classroom delete cleanup uses (deleteGitHubArtifacts).
 */

import { GitHubProvider } from '../git/index.ts';

export const ORG_REPO_PERMISSIONS = ['none', 'read', 'write'] as const;
export type OrgRepoPermission = (typeof ORG_REPO_PERMISSIONS)[number];

/** The only fields this service will ever send to GitHub. */
export const ORG_REPO_SETTINGS_FIELDS = [
  'default_repository_permission',
  'members_can_create_repositories',
] as const;
export type OrgRepoSettingsField = (typeof ORG_REPO_SETTINGS_FIELDS)[number];

export interface OrgRepoSettingsUpdate {
  default_repository_permission?: OrgRepoPermission;
  members_can_create_repositories?: boolean;
}

export type OrgRepoSettingsErrorCode =
  | 'INVALID_INPUT'
  | 'NO_ORGANIZATION'
  | 'APP_NOT_INSTALLED'
  | 'NO_GITHUB_TOKEN'
  | 'NOT_ORG_OWNER'
  | 'RATE_LIMITED'
  | 'GITHUB_ERROR';

export class OrgRepoSettingsError extends Error {
  code: OrgRepoSettingsErrorCode;
  /** GitHub's HTTP status, when the refusal came from GitHub. */
  status?: number;

  constructor(code: OrgRepoSettingsErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'OrgRepoSettingsError';
    this.code = code;
    this.status = status;
  }
}

export const GITHUB_REFUSED_CHANGE_MESSAGE =
  "GitHub didn't allow this change. Only organization owners can change these settings, and the Classmoji app needs access to the organization.";
export const GITHUB_RATE_LIMITED_MESSAGE =
  'GitHub is rate limiting requests right now. Try again in a few minutes.';
export const GITHUB_SIGN_IN_AGAIN_MESSAGE =
  'Your GitHub sign-in has expired. Sign out and sign in again, then retry.';

/** The classroom's linked organization, as the classroom gate loaded it. */
export interface OrgRepoSettingsTarget {
  login?: string | null;
  provider?: string | null;
  github_installation_id?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate an update against the settings this page edits. Returns a fresh
 * object holding only the accepted fields; refuses anything else.
 */
export function parseOrgRepoSettingsInput(input: unknown): OrgRepoSettingsUpdate {
  if (!isRecord(input)) {
    throw new OrgRepoSettingsError('INVALID_INPUT', 'Expected an object of settings to update.');
  }

  const unknownKeys = Object.keys(input).filter(
    key => !(ORG_REPO_SETTINGS_FIELDS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) {
    throw new OrgRepoSettingsError(
      'INVALID_INPUT',
      `Only ${ORG_REPO_SETTINGS_FIELDS.join(' and ')} can be changed here (got: ${unknownKeys.join(', ')}).`
    );
  }

  const updates: OrgRepoSettingsUpdate = {};

  const permission = input.default_repository_permission;
  if (permission !== undefined) {
    if (
      typeof permission !== 'string' ||
      !(ORG_REPO_PERMISSIONS as readonly string[]).includes(permission)
    ) {
      throw new OrgRepoSettingsError(
        'INVALID_INPUT',
        `default_repository_permission must be one of: ${ORG_REPO_PERMISSIONS.join(', ')}.`
      );
    }
    updates.default_repository_permission = permission as OrgRepoPermission;
  }

  const canCreate = input.members_can_create_repositories;
  if (canCreate !== undefined) {
    if (typeof canCreate !== 'boolean') {
      throw new OrgRepoSettingsError(
        'INVALID_INPUT',
        'members_can_create_repositories must be true or false.'
      );
    }
    updates.members_can_create_repositories = canCreate;
  }

  if (Object.keys(updates).length === 0) {
    throw new OrgRepoSettingsError(
      'INVALID_INPUT',
      `Provide ${ORG_REPO_SETTINGS_FIELDS.join(' and/or ')}.`
    );
  }

  return updates;
}

/** The classroom's GitHub organization login, or a typed refusal. */
export function requireGitHubOrgLogin(gitOrganization: OrgRepoSettingsTarget | null | undefined) {
  const login = gitOrganization?.login;
  if (!login || (gitOrganization?.provider && gitOrganization.provider !== 'GITHUB')) {
    throw new OrgRepoSettingsError(
      'NO_ORGANIZATION',
      'This classroom is not connected to a GitHub organization.'
    );
  }
  // A user-to-server token only reaches organizations the App is installed on.
  if (!gitOrganization?.github_installation_id) {
    throw new OrgRepoSettingsError(
      'APP_NOT_INSTALLED',
      `The Classmoji GitHub App isn't installed on "${login}". Install it to manage repository settings.`
    );
  }
  return login;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const isRateLimited = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  if (headers && String(headers['x-ratelimit-remaining']) === '0') return true;
  const message = error instanceof Error ? error.message : '';
  return /rate limit/i.test(message);
};

/** Turn a GitHub failure into the typed error both callers report. */
export function toOrgRepoSettingsError(error: unknown): OrgRepoSettingsError {
  if (error instanceof OrgRepoSettingsError) return error;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status === 401) {
    return new OrgRepoSettingsError('NO_GITHUB_TOKEN', GITHUB_SIGN_IN_AGAIN_MESSAGE, status);
  }
  if (isRateLimited(error)) {
    return new OrgRepoSettingsError('RATE_LIMITED', GITHUB_RATE_LIMITED_MESSAGE, status);
  }
  if (status === 403 || status === 404) {
    return new OrgRepoSettingsError('NOT_ORG_OWNER', GITHUB_REFUSED_CHANGE_MESSAGE, status);
  }
  return new OrgRepoSettingsError(
    'GITHUB_ERROR',
    `GitHub couldn't apply the change (${message}).`,
    status
  );
}

// A type alias (not an interface) so it stays assignable to JSON column types.
export type OrgRepoSettingsChange = {
  from: string | boolean | null;
  to: string | boolean;
};

export interface OrgRepoSettingsResult {
  org: string;
  /** Per changed field, the value before and after. */
  changes: Partial<Record<OrgRepoSettingsField, OrgRepoSettingsChange>>;
  /** The settings as GitHub reports them after the change (only the changed fields). */
  settings: OrgRepoSettingsUpdate;
  /**
   * Scalar digest of the new values, e.g.
   * "default_repository_permission=read;members_can_create_repositories=false".
   * Audit rows carry it as `data.value`, which joins the audit service's 5s
   * dedup key, so two different edits in quick succession both get recorded.
   */
  value: string;
}

/**
 * These calls answer a person waiting on the page or the tool. Octokit's retry
 * plugin would otherwise retry a GitHub 5xx three times with 1s/4s/9s backoff,
 * so a failing save would sit for about 14 seconds before saying so. One
 * attempt, and the error is reported straight away.
 */
const NO_RETRY = { retries: 0 } as const;

const pickSetting = (
  source: Record<string, unknown> | null | undefined,
  field: OrgRepoSettingsField
): string | boolean | null => {
  const value = source?.[field];
  return typeof value === 'string' || typeof value === 'boolean' ? value : null;
};

/**
 * Apply an update to the classroom's GitHub organization with the requesting
 * user's own GitHub token.
 *
 * @param gitOrganization - The classroom's linked organization, from the
 *   classroom gate's result. Its `login` is the only org this call can touch.
 * @param userToken - The requesting user's GitHub user-to-server token.
 * @param input - The requested settings; validated with parseOrgRepoSettingsInput.
 */
export async function updateOrgRepoSettings({
  gitOrganization,
  userToken,
  input,
}: {
  gitOrganization: OrgRepoSettingsTarget | null | undefined;
  userToken: string | null | undefined;
  input: unknown;
}): Promise<OrgRepoSettingsResult> {
  const updates = parseOrgRepoSettingsInput(input);
  const org = requireGitHubOrgLogin(gitOrganization);

  if (!userToken) {
    throw new OrgRepoSettingsError('NO_GITHUB_TOKEN', GITHUB_SIGN_IN_AGAIN_MESSAGE);
  }

  // The user's own token: GitHub applies the intersection of the App's
  // permissions and this person's role in the organization. The immediate
  // variant reports a rate limit as an error rather than waiting it out.
  const octokit = GitHubProvider.getImmediateUserOctokit(userToken);

  // Current values, for the before → after record. Best effort: a failed read
  // leaves `from` null and the update itself decides the outcome.
  let before: Record<string, unknown> | null = null;
  try {
    const { data } = await octokit.request('GET /orgs/{org}', { org, request: NO_RETRY });
    before = data as unknown as Record<string, unknown>;
  } catch {
    before = null;
  }

  // Built field by field from validated values; `org` last so nothing in the
  // body can name a different organization.
  const body: OrgRepoSettingsUpdate = {};
  if (updates.default_repository_permission !== undefined) {
    body.default_repository_permission = updates.default_repository_permission;
  }
  if (updates.members_can_create_repositories !== undefined) {
    body.members_can_create_repositories = updates.members_can_create_repositories;
  }

  let after: Record<string, unknown> | null = null;
  try {
    const { data } = await octokit.request('PATCH /orgs/{org}', {
      ...body,
      org,
      request: NO_RETRY,
    });
    after = data as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    throw toOrgRepoSettingsError(error);
  }

  const changes: OrgRepoSettingsResult['changes'] = {};
  const settings: OrgRepoSettingsUpdate = {};
  const digest: string[] = [];
  for (const field of ORG_REPO_SETTINGS_FIELDS) {
    const requested = body[field];
    if (requested === undefined) continue;
    const reported = pickSetting(after, field);
    const to = (reported ?? requested) as string | boolean;
    changes[field] = { from: pickSetting(before, field), to };
    (settings as Record<string, unknown>)[field] = to;
    digest.push(`${field}=${String(to)}`);
  }

  return { org, changes, settings, value: digest.join(';') };
}

export type OrgOwnerStatus = 'owner' | 'not_owner' | 'unknown';

/** How long the page waits on the membership check before treating it as unknown. */
export const ORG_OWNER_CHECK_TIMEOUT_MS = 3000;

/**
 * Whether the user can change organization settings, from their own
 * membership (GET /user/memberships/orgs/{org} with their token):
 *   - 'owner'     — active membership with role 'admin'
 *   - 'not_owner' — GitHub reported a membership that is not an active owner
 *   - 'unknown'   — no token, or the check failed or timed out; callers should
 *                   let the user try and let GitHub decide
 */
export async function getOrgOwnerStatus(
  orgLogin: string,
  userToken: string | null | undefined,
  { timeoutMs = ORG_OWNER_CHECK_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<OrgOwnerStatus> {
  if (!userToken) return 'unknown';
  try {
    const octokit = GitHubProvider.getImmediateUserOctokit(userToken);
    const { data } = await octokit.request('GET /user/memberships/orgs/{org}', {
      org: orgLogin,
      // A slow answer is treated like no answer: the page stays editable. No
      // retries, so the timeout bounds the whole check (a timed-out request
      // would otherwise be retried as a server error, with backoff).
      request: { signal: AbortSignal.timeout(timeoutMs), retries: 0 },
    });
    return data?.role === 'admin' && data?.state === 'active' ? 'owner' : 'not_owner';
  } catch {
    return 'unknown';
  }
}
