/**
 * Unit tests for the GitHub organization repository settings page
 * (admin.$class.settings.repos).
 *
 * The route runs the real shared service (whitelist, organization lookup,
 * error mapping); only GitHub itself is replaced, at the Octokit layer. Pins:
 *   - apply only the settings this page edits; anything else is refused with
 *     the route's error shape and nothing is sent to GitHub;
 *   - the change goes to the classroom's own organization, with the requesting
 *     user's own GitHub token, never the App installation;
 *   - a GitHub 403 is reported as "only organization owners";
 *   - each change writes an audit row with old → new values;
 *   - the loader reports whether the viewer can edit, from their own
 *     organization membership.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  getAuthSession: vi.fn(),
  getGitProvider: vi.fn(),
  getOrganization: vi.fn(),
  getUserOctokit: vi.fn(),
  userRequest: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));

// GitHub, replaced at the Octokit layer for the real service below.
vi.mock('../../../../../packages/services/src/git/index.ts', () => ({
  GitHubProvider: { getUserOctokit: (...a: unknown[]) => mocks.getUserOctokit(...a) },
}));

vi.mock('@classmoji/services', async () => {
  const orgRepoSettings =
    await import('../../../../../packages/services/src/classmoji/orgRepoSettings.service.ts');
  return {
    ClassmojiService: { orgRepoSettings },
    OrgRepoSettingsError: orgRepoSettings.OrgRepoSettingsError,
    getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
  };
});

// The action and loader are what is under test; the view only needs to import.
vi.mock('antd', () => ({ Select: () => null, Switch: () => null, Alert: () => null }));
vi.mock('~/hooks', () => ({ useNotifiedFetcher: () => ({ fetcher: { submit: vi.fn() } }) }));
vi.mock('~/components/features/InstallAppBanner', () => ({ default: () => null }));
vi.mock('react-router', () => ({ useParams: () => ({}) }));

const route = await import('../admin.$class.settings.repos/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const GIT_ORG = { login: 'myorg', provider: 'GITHUB', github_installation_id: '123' };
const USER_TOKEN = 'ghu_owner_token';

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status, response: { headers: {} } });

const post = (body: unknown) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/settings/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]) as Promise<Record<string, unknown>>;

const load = () =>
  route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/settings/repos`),
  } as unknown as Parameters<typeof route.loader>[0]) as Promise<Record<string, unknown>>;

const patchCalls = () => mocks.userRequest.mock.calls.filter(c => c[0] === 'PATCH /orgs/{org}');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: {
      id: 'class-1',
      slug: CLASS_SLUG,
      status: 'ACTIVE',
      is_example: false,
      git_organization: GIT_ORG,
    },
    membership: { role: 'OWNER' },
  });
  mocks.getAuthSession.mockResolvedValue({ userId: 'owner-1', token: USER_TOKEN });
  mocks.getUserOctokit.mockReturnValue({ request: mocks.userRequest });
  mocks.userRequest.mockImplementation(async (r: string, params: Record<string, unknown>) => {
    if (r === 'GET /orgs/{org}') {
      return {
        data: {
          login: params.org,
          default_repository_permission: 'none',
          members_can_create_repositories: false,
        },
      };
    }
    if (r === 'PATCH /orgs/{org}') {
      const { org, ...rest } = params;
      return {
        data: {
          login: org,
          default_repository_permission: 'none',
          members_can_create_repositories: false,
          ...rest,
        },
      };
    }
    if (r === 'GET /user/memberships/orgs/{org}') {
      return { data: { role: 'admin', state: 'active' } };
    }
    throw new Error(`unexpected route ${r}`);
  });
  mocks.getGitProvider.mockReturnValue({ getOrganization: mocks.getOrganization });
  mocks.getOrganization.mockResolvedValue({
    login: 'myorg',
    default_repository_permission: 'none',
    members_can_create_repositories: false,
  });
});

describe('repository settings action', () => {
  it('applies a change from the page with the requesting user token', async () => {
    const result = await post({ default_repository_permission: 'read' });

    expect(result).toEqual({ success: 'Permissions updated', action: 'UPDATE_MEMBER_PERMISSIONS' });
    expect(mocks.getUserOctokit).toHaveBeenCalledWith(USER_TOKEN);
    expect(patchCalls()).toEqual([
      ['PATCH /orgs/{org}', { default_repository_permission: 'read', org: 'myorg' }],
    ]);
    // Changes never run with the App installation.
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
  });

  it('writes an audit row with old and new values', async () => {
    await post({ members_can_create_repositories: true });

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledOnce();
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'REPO_SETTINGS',
      resourceId: 'class-1',
      metadata: {
        tool: 'web:settings.repos',
        org: 'myorg',
        changes: { members_can_create_repositories: { from: false, to: true } },
        value: 'members_can_create_repositories=true',
      },
    });
  });

  it.each([
    [
      'another organization setting',
      { members_can_create_repositories: true, billing_email: 'x@y.z' },
    ],
    ['an org override', { default_repository_permission: 'read', org: 'other-org' }],
    ['an unsupported permission', { default_repository_permission: 'admin' }],
    ['a non-boolean flag', { members_can_create_repositories: 'yes' }],
    ['an empty body', {}],
  ])('refuses %s with the route error shape and sends nothing', async (_label, body) => {
    const result = await post(body);

    expect(result).toMatchObject({ action: 'UPDATE_MEMBER_PERMISSIONS' });
    expect(typeof result.error).toBe('string');
    expect(mocks.userRequest).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('reports a GitHub 403 as organization owners only, without an audit row', async () => {
    mocks.userRequest.mockImplementation(async (r: string) => {
      if (r === 'PATCH /orgs/{org}') throw httpError(403);
      return { data: {} };
    });

    const result = await post({ default_repository_permission: 'write' });

    expect(result).toEqual({
      error: 'Only GitHub organization owners can change these settings.',
      action: 'UPDATE_MEMBER_PERMISSIONS',
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('asks the user to sign in again when there is no GitHub token', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'owner-1', token: null });

    const result = await post({ default_repository_permission: 'read' });

    expect(result.error).toMatch(/sign in again/);
    expect(mocks.getUserOctokit).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('reports other GitHub failures in the route error shape', async () => {
    mocks.userRequest.mockImplementation(async (r: string) => {
      if (r === 'PATCH /orgs/{org}') throw httpError(500);
      return { data: {} };
    });

    const result = await post({ default_repository_permission: 'read' });

    expect(result.error).toMatch(/GitHub couldn't apply the change/);
  });

  it('refuses a classroom whose GitHub App is not installed', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'owner-1',
      classroom: {
        id: 'class-1',
        status: 'ACTIVE',
        git_organization: { ...GIT_ORG, github_installation_id: null },
      },
      membership: { role: 'OWNER' },
    });

    const result = await post({ default_repository_permission: 'read' });

    expect(result.error).toMatch(/isn't installed/);
    expect(mocks.userRequest).not.toHaveBeenCalled();
  });

  it('is owner-gated through the classroom gate', async () => {
    await post({ default_repository_permission: 'read' });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: CLASS_SLUG, allowedRoles: ['OWNER'] })
    );
    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });
});

describe('repository settings loader', () => {
  it('can edit when the viewer is an active organization owner', async () => {
    const data = await load();

    expect(data).toMatchObject({ canEdit: true, error: null, gitOrgLogin: 'myorg' });
    expect(mocks.userRequest).toHaveBeenCalledWith('GET /user/memberships/orgs/{org}', {
      org: 'myorg',
    });
    expect(mocks.getUserOctokit).toHaveBeenCalledWith(USER_TOKEN);
  });

  it('cannot edit when the viewer is a member but not an owner', async () => {
    mocks.userRequest.mockResolvedValue({ data: { role: 'member', state: 'active' } });
    expect(await load()).toMatchObject({ canEdit: false, error: null });
  });

  it('leaves editing on when the membership check fails', async () => {
    mocks.userRequest.mockRejectedValue(httpError(403));
    expect(await load()).toMatchObject({ canEdit: true });
  });

  it('leaves editing on when there is no GitHub token, so the action explains', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'owner-1', token: null });
    expect(await load()).toMatchObject({ canEdit: true });
    expect(mocks.getUserOctokit).not.toHaveBeenCalled();
  });

  it('never returns the token', async () => {
    expect(JSON.stringify(await load())).not.toContain(USER_TOKEN);
  });
});
