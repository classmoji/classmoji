/**
 * Unit tests for the GitHub organization repository settings service, shared by
 * the web settings route and the MCP tool. Pins:
 *   - only the settings the page edits are accepted, with their allowed values;
 *   - the organization is the classroom's own, whatever the input carries;
 *   - the GitHub payload is built field by field;
 *   - every GitHub call uses the requesting user's token, never the App
 *     installation;
 *   - GitHub refusals come back as typed, readable errors.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserOctokit: vi.fn(),
  getImmediateUserOctokit: vi.fn(),
  getGitProvider: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../../git/index.ts', () => ({
  GitHubProvider: {
    getUserOctokit: (...a: unknown[]) => mocks.getUserOctokit(...a),
    getImmediateUserOctokit: (...a: unknown[]) => mocks.getImmediateUserOctokit(...a),
  },
  getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
}));

const {
  parseOrgRepoSettingsInput,
  updateOrgRepoSettings,
  getOrgOwnerStatus,
  OrgRepoSettingsError,
  GITHUB_REFUSED_CHANGE_MESSAGE,
  GITHUB_RATE_LIMITED_MESSAGE,
  GITHUB_SIGN_IN_AGAIN_MESSAGE,
} = await import('../orgRepoSettings.service.ts');

const ORG = { login: 'myorg', provider: 'GITHUB', github_installation_id: '123' };
const USER_TOKEN = 'ghu_user_token';

const httpError = (status: number, message = `HTTP ${status}`, headers = {}) =>
  Object.assign(new Error(message), { status, response: { headers } });

/** GET returns the current values; PATCH echoes the merged org back. */
const githubOrg = (current: Record<string, unknown>) => {
  mocks.request.mockImplementation(async (route: string, params: Record<string, unknown>) => {
    if (route === 'GET /orgs/{org}') return { data: { login: params.org, ...current } };
    if (route === 'PATCH /orgs/{org}') {
      const { org, ...rest } = params;
      return { data: { login: org, ...current, ...rest } };
    }
    throw new Error(`unexpected route ${route}`);
  });
};

const patchCall = () => mocks.request.mock.calls.find(c => c[0] === 'PATCH /orgs/{org}');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getImmediateUserOctokit.mockReturnValue({ request: mocks.request });
  githubOrg({ default_repository_permission: 'none', members_can_create_repositories: false });
});

describe('parseOrgRepoSettingsInput', () => {
  it('accepts the two settings the page edits', () => {
    expect(
      parseOrgRepoSettingsInput({
        default_repository_permission: 'read',
        members_can_create_repositories: true,
      })
    ).toEqual({ default_repository_permission: 'read', members_can_create_repositories: true });
  });

  it.each(['none', 'read', 'write'])('accepts permission %s', value => {
    expect(parseOrgRepoSettingsInput({ default_repository_permission: value })).toEqual({
      default_repository_permission: value,
    });
  });

  it.each(['admin', 'READ', '', 1, null])('refuses permission value %s', value => {
    expect(() => parseOrgRepoSettingsInput({ default_repository_permission: value })).toThrow(
      OrgRepoSettingsError
    );
  });

  it('refuses a non-boolean repository creation flag', () => {
    expect(() => parseOrgRepoSettingsInput({ members_can_create_repositories: 'true' })).toThrow(
      /true or false/
    );
  });

  it('refuses any other field, including org', () => {
    for (const extra of [{ billing_email: 'x@y.z' }, { org: 'other-org' }, { name: 'n' }]) {
      try {
        parseOrgRepoSettingsInput({ members_can_create_repositories: true, ...extra });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OrgRepoSettingsError);
        expect((error as InstanceType<typeof OrgRepoSettingsError>).code).toBe('INVALID_INPUT');
      }
    }
  });

  it('refuses an empty update and a non-object body', () => {
    expect(() => parseOrgRepoSettingsInput({})).toThrow(OrgRepoSettingsError);
    expect(() => parseOrgRepoSettingsInput(null)).toThrow(OrgRepoSettingsError);
    expect(() => parseOrgRepoSettingsInput([])).toThrow(OrgRepoSettingsError);
    expect(() => parseOrgRepoSettingsInput('read')).toThrow(OrgRepoSettingsError);
  });
});

describe('updateOrgRepoSettings', () => {
  it('uses the requesting user token for every GitHub call, never the App installation', async () => {
    await updateOrgRepoSettings({
      gitOrganization: ORG,
      userToken: USER_TOKEN,
      input: { default_repository_permission: 'read' },
    });

    expect(mocks.getImmediateUserOctokit).toHaveBeenCalledWith(USER_TOKEN);
    for (const call of mocks.getImmediateUserOctokit.mock.calls) expect(call[0]).toBe(USER_TOKEN);
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
    // The client that reports rate limits, not the one that waits them out.
    expect(mocks.getUserOctokit).not.toHaveBeenCalled();
  });

  it('sends exactly the validated fields to the classroom organization', async () => {
    await updateOrgRepoSettings({
      gitOrganization: ORG,
      userToken: USER_TOKEN,
      input: { members_can_create_repositories: true },
    });

    expect(patchCall()).toEqual([
      'PATCH /orgs/{org}',
      { members_can_create_repositories: true, org: 'myorg' },
    ]);
  });

  it('refuses input that names an organization, and sends nothing to GitHub', async () => {
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read', org: 'other-org' },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('returns old and new values and a scalar value digest', async () => {
    const result = await updateOrgRepoSettings({
      gitOrganization: ORG,
      userToken: USER_TOKEN,
      input: { default_repository_permission: 'read', members_can_create_repositories: true },
    });

    expect(result).toEqual({
      org: 'myorg',
      changes: {
        default_repository_permission: { from: 'none', to: 'read' },
        members_can_create_repositories: { from: false, to: true },
      },
      settings: { default_repository_permission: 'read', members_can_create_repositories: true },
      value: 'default_repository_permission=read;members_can_create_repositories=true',
    });
  });

  it('records a null old value when the current settings cannot be read', async () => {
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'GET /orgs/{org}') throw httpError(500);
      return { data: { default_repository_permission: 'write' } };
    });

    const result = await updateOrgRepoSettings({
      gitOrganization: ORG,
      userToken: USER_TOKEN,
      input: { default_repository_permission: 'write' },
    });
    expect(result.changes.default_repository_permission).toEqual({ from: null, to: 'write' });
  });

  it('asks the user to sign in again when there is no token, without calling GitHub', async () => {
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: null,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'NO_GITHUB_TOKEN', message: GITHUB_SIGN_IN_AGAIN_MESSAGE });
    expect(mocks.getImmediateUserOctokit).not.toHaveBeenCalled();
  });

  it('refuses a classroom without a GitHub organization or App installation', async () => {
    await expect(
      updateOrgRepoSettings({
        gitOrganization: null,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'NO_ORGANIZATION' });
    await expect(
      updateOrgRepoSettings({
        gitOrganization: { ...ORG, provider: 'GITLAB' },
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'NO_ORGANIZATION' });
    await expect(
      updateOrgRepoSettings({
        gitOrganization: { ...ORG, github_installation_id: null },
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'APP_NOT_INSTALLED' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([403, 404])('reports a GitHub %i as a refused change', async status => {
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'PATCH /orgs/{org}') throw httpError(status);
      return { data: {} };
    });
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({
      code: 'NOT_ORG_OWNER',
      message: GITHUB_REFUSED_CHANGE_MESSAGE,
      status,
    });
  });

  it('reports a GitHub 401 as a sign-in problem', async () => {
    mocks.request.mockRejectedValue(httpError(401, 'Bad credentials'));
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'NO_GITHUB_TOKEN' });
  });

  it.each([
    [
      'a primary limit (403, none remaining)',
      httpError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
    ],
    ['a secondary limit (429)', httpError(429, 'You have exceeded a secondary rate limit')],
  ])('reports %s as RATE_LIMITED, not as a refused change', async (_label, error) => {
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'PATCH /orgs/{org}') throw error;
      return { data: {} };
    });
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', message: GITHUB_RATE_LIMITED_MESSAGE });
  });

  it('reports other GitHub failures with their message', async () => {
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'PATCH /orgs/{org}') throw httpError(422, 'Validation Failed');
      return { data: {} };
    });
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: USER_TOKEN,
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({
      code: 'GITHUB_ERROR',
      message: expect.stringContaining('Validation Failed'),
    });
  });
});

describe('getOrgOwnerStatus', () => {
  it('is owner for an active admin membership, checked with the user token', async () => {
    mocks.request.mockResolvedValue({ data: { role: 'admin', state: 'active' } });
    await expect(getOrgOwnerStatus('myorg', USER_TOKEN)).resolves.toBe('owner');
    expect(mocks.getImmediateUserOctokit).toHaveBeenCalledWith(USER_TOKEN);
    expect(mocks.request).toHaveBeenCalledWith('GET /user/memberships/orgs/{org}', {
      org: 'myorg',
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
    expect(mocks.getUserOctokit).not.toHaveBeenCalled();
  });

  it('is not_owner for a member or a pending admin', async () => {
    mocks.request.mockResolvedValue({ data: { role: 'member', state: 'active' } });
    await expect(getOrgOwnerStatus('myorg', USER_TOKEN)).resolves.toBe('not_owner');
    mocks.request.mockResolvedValue({ data: { role: 'admin', state: 'pending' } });
    await expect(getOrgOwnerStatus('myorg', USER_TOKEN)).resolves.toBe('not_owner');
  });

  it('is unknown when the check fails or there is no token', async () => {
    mocks.request.mockRejectedValue(httpError(404));
    await expect(getOrgOwnerStatus('myorg', USER_TOKEN)).resolves.toBe('unknown');
    await expect(getOrgOwnerStatus('myorg', null)).resolves.toBe('unknown');
  });

  it('is unknown when GitHub does not answer within the timeout', async () => {
    // Behaves like fetch: settles only when the request's signal aborts.
    mocks.request.mockImplementation(
      (_route: string, params: { request: { signal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.request.signal.addEventListener('abort', () =>
            reject(params.request.signal.reason)
          );
        })
    );
    const startedAt = Date.now();
    await expect(getOrgOwnerStatus('myorg', USER_TOKEN, { timeoutMs: 20 })).resolves.toBe(
      'unknown'
    );
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
