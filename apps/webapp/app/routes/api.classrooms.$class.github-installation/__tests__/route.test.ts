import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "check again" endpoint behind the install banner.
 *
 * Two things are pinned here.
 *
 * 1. WHO may run it. The gate is `requireClassroomStaff` (OWNER/TEACHER), not
 *    `requireClassroomTeachingTeam` — an assistant cannot install the app on the
 *    org, and the banner is not offered to them, but the button's absence is not
 *    a permission check. Swapping this gate is the mistake the first test exists
 *    to catch, so it asserts the identity of the helper the route imports.
 *
 * 2. That every status the service can return survives the trip to the client
 *    intact, including `rate-limited`'s retry hint — the banner renders these
 *    verbatim, so a dropped field silently becomes a wrong sentence.
 */

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
  repairInstallation: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  requireClassroomAdmin: vi.fn(),
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitOrganization: {
      repairInstallation: (...a: unknown[]) => mocks.repairInstallation(...a),
    },
  },
}));

const { action } = await import('../route.ts');

const GITHUB_ORG = {
  id: 'org-1',
  provider: 'GITHUB',
  login: 'cs52-org',
  github_installation_id: null,
};

const gateResult = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  classroom: {
    id: 'class-1',
    slug: 'cs52-26f',
    is_example: false,
    git_organization: GITHUB_ORG,
    ...overrides,
  },
  membership: { role: 'TEACHER' },
});

const args = (method = 'POST') =>
  ({
    params: { class: 'cs52-26f' },
    request: new Request('http://localhost/api/classrooms/cs52-26f/github-installation', {
      method,
    }),
  }) as unknown as Parameters<typeof action>[0];

// `data()` hands back a DataWithResponseInit rather than a Response.
const unwrap = (result: unknown) =>
  result as { data: Record<string, unknown>; init?: ResponseInit };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomStaff.mockResolvedValue(gateResult());
  mocks.repairInstallation.mockResolvedValue({ status: 'connected', org: GITHUB_ORG });
  mocks.addClassroomAuditLog.mockResolvedValue(undefined);
});

describe('POST /api/classrooms/:class/github-installation', () => {
  it('refuses anything but POST, before it authorizes anything', async () => {
    const res = (await action(args('GET'))) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(mocks.requireClassroomStaff).not.toHaveBeenCalled();
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  it('gates on OWNER/TEACHER, never on the teaching team', async () => {
    await action(args());
    expect(mocks.requireClassroomStaff).toHaveBeenCalledTimes(1);
    expect(mocks.requireClassroomTeachingTeam).not.toHaveBeenCalled();
    expect(mocks.requireClassroomStaff).toHaveBeenCalledWith(
      expect.any(Request),
      'cs52-26f',
      expect.objectContaining({ action: 'check_github_installation' })
    );
  });

  it('propagates the gate refusal instead of repairing anything', async () => {
    mocks.requireClassroomStaff.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(action(args())).rejects.toBeInstanceOf(Response);
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  it('reports the outcome and audits the attempt', async () => {
    const result = unwrap(await action(args()));

    expect(mocks.repairInstallation).toHaveBeenCalledWith('org-1');
    expect(result.data).toEqual({ status: 'connected', login: 'cs52-org' });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-1',
        userId: 'user-1',
        role: 'TEACHER',
        action: 'UPDATE',
        resourceType: 'GIT_ORGANIZATION',
        resourceId: 'org-1',
        metadata: expect.objectContaining({ git_org_login: 'cs52-org', outcome: 'connected' }),
      })
    );
  });

  it.each([
    ['already-connected'],
    ['not-installed'],
    ['login-moved'],
    ['suspended'],
    ['wrong-app'],
    ['not-found'],
  ])('passes the %s status straight through', async status => {
    mocks.repairInstallation.mockResolvedValue({ status });
    const result = unwrap(await action(args()));
    expect(result.data).toEqual({ status, login: 'cs52-org' });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: status }) })
    );
  });

  it('keeps the retry hint on a rate-limited answer', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'rate-limited', retryAfterSeconds: 12 });
    const result = unwrap(await action(args()));
    expect(result.data).toEqual({
      status: 'rate-limited',
      login: 'cs52-org',
      retryAfterSeconds: 12,
    });
  });

  it('never leaks the internal error message to the client', async () => {
    mocks.repairInstallation.mockResolvedValue({
      status: 'error',
      message: 'app-jwt signing failed for app 12345',
    });
    const result = unwrap(await action(args()));
    expect(result.data).toEqual({ status: 'error', login: 'cs52-org' });
  });

  it('refuses a non-GitHub org without calling GitHub', async () => {
    mocks.requireClassroomStaff.mockResolvedValue(
      gateResult({ git_organization: { ...GITHUB_ORG, provider: 'GITLAB' } })
    );
    const result = unwrap(await action(args()));
    expect(result.init?.status).toBe(400);
    expect(result.data).toMatchObject({ status: 'not-github' });
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  // Its own status, not `not-github`. The example classroom IS on GitHub and
  // its owner can read the org login on the very page that asked, so the
  // "not hosted on GitHub" sentence would be a lie; the banner renders
  // `not-eligible` as "can't be connected", which is true.
  it('refuses the example classroom, whose org is a fixture', async () => {
    mocks.requireClassroomStaff.mockResolvedValue(gateResult({ is_example: true }));
    const result = unwrap(await action(args()));
    expect(result.init?.status).toBe(400);
    expect(result.data).toEqual({ status: 'not-eligible', login: 'cs52-org' });
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  it('refuses a classroom with no git organization at all', async () => {
    mocks.requireClassroomStaff.mockResolvedValue(gateResult({ git_organization: null }));
    const result = unwrap(await action(args()));
    expect(result.init?.status).toBe(400);
    expect(result.data).toEqual({ status: 'not-github', login: null });
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });
});
