/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * "View as" (better-auth admin impersonation, POST /admin/impersonate-user)
 * is started only by a platform admin (PLATFORM_ADMIN_USER_IDS), whatever a
 * user's role, and never targets an admin: neither a platform admin nor a
 * user whose role contains "admin". Through the REAL exported `auth`, over
 * `auth.handler`; only Prisma and the service layer are stood in.
 *
 * Two layers, each tested on its own:
 *   (a) `hooks.before` refuses the request before the endpoint runs, with its
 *       own messages (1.4.18's endpoint also refuses admin targets, with
 *       "You cannot impersonate admins"; from 1.5 it lets an `adminUserIds`
 *       caller through, so the message tells the layers apart);
 *   (b) `databaseHooks.session.create.before` refuses any session created
 *       with `impersonatedBy` by someone who is not a platform admin, or for
 *       an admin, whatever path creates it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
// Read once at import. `12345` is a platform admin whose id a JSON body can
// also send as a number.
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1,admin-2,12345';

const mocks = vi.hoisted(() => {
  const user = (id: string, role: string | null) => ({
    id,
    name: id,
    email: `${id}@example.edu`,
    emailVerified: true,
    image: null,
    created_at: new Date(),
    updated_at: new Date(),
    role,
    banned: false,
  });
  const users: Record<string, Record<string, unknown>> = {
    'admin-1': user('admin-1', null),
    'admin-2': user('admin-2', null),
    '12345': user('12345', null),
    'role-admin': user('role-admin', 'admin'),
    'role-mixed': user('role-mixed', 'user,Admin'),
    'owner-1': user('owner-1', null),
    'student-1': user('student-1', null),
  };
  const state = {
    sessions: [] as Record<string, any>[],
    created: [] as Record<string, any>[],
  };
  const noop = () => ({
    findFirst: vi.fn(() => Promise.resolve(null)),
    findUnique: vi.fn(() => Promise.resolve(null)),
    findMany: vi.fn(() => Promise.resolve([])),
    create: vi.fn(({ data }: any) => Promise.resolve(data)),
    update: vi.fn(({ data }: any) => Promise.resolve(data)),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    delete: vi.fn(() => Promise.resolve({})),
    deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    count: vi.fn(() => Promise.resolve(0)),
  });
  const client: any = {};
  for (const model of [
    'account',
    'verification',
    'oauthAccessToken',
    'oauthApplication',
    'platformAuditLog',
  ]) {
    client[model] = noop();
  }
  client.user = {
    ...noop(),
    // better-auth's adapter reads users with findFirst; the "view as" rule
    // reads the role with findUnique.
    findFirst: vi.fn(({ where }: any) => Promise.resolve(users[where?.id] ?? null)),
    findUnique: vi.fn(({ where }: any) =>
      Promise.resolve(users[where?.id] ? { role: users[where.id]!.role } : null)
    ),
  };
  client.session = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(state.sessions.find(row => row.token === where?.token) ?? null)
    ),
    // better-auth reads the row it is about to delete, for the delete hooks.
    findMany: vi.fn(({ where }: any) =>
      Promise.resolve(
        state.sessions.filter(row =>
          where?.user_id !== undefined ? row.user_id === where.user_id : row.token === where?.token
        )
      )
    ),
    create: vi.fn(({ data }: any) => {
      const row = { id: `sess-new-${state.created.length}`, ...data };
      state.created.push(row);
      state.sessions.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn(({ where, data }: any) => {
      const row = state.sessions.find(s => s.token === where?.token || s.id === where?.id);
      return Promise.resolve({ ...row, ...data });
    }),
    delete: vi.fn(({ where }: any) => {
      state.sessions = state.sessions.filter(s => s.token !== where?.token);
      return Promise.resolve({});
    }),
    deleteMany: vi.fn(({ where }: any) => {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter(s =>
        where?.id !== undefined
          ? s.id !== where.id
          : where?.user_id !== undefined
            ? s.user_id !== where.user_id
            : s.token !== where?.token
      );
      return Promise.resolve({ count: before - state.sessions.length });
    }),
  };
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  return { state, users, client };
});

vi.mock('@classmoji/database', async () => {
  const { standInClient } = await import('./support/prismaStandIn.ts');
  const client = standInClient(mocks.client);
  return { default: () => client };
});
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const {
  ACCOUNT_LINK_VIEWING_AS_MESSAGE,
  auth,
  COOKIE_PREFIX,
  VIEW_AS_ADMIN_REFUSED_MESSAGE,
  VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE,
  mayViewAs,
  roleIncludesAdmin,
} = await import('../server.ts');

const BASE = 'http://localhost:3000/api/auth';

/** A signed-in session for `userId`, stored as Prisma returns it. */
function signIn(userId: string): string {
  const token = `token-${userId}`;
  mocks.state.sessions.push({
    id: `sess-${userId}`,
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + 86_400_000),
    created_at: new Date(),
    updated_at: new Date(),
    ip_address: null,
    user_agent: null,
    impersonatedBy: null,
  });
  return token;
}

async function signedCookie(name: string, value: string): Promise<string> {
  const serialized = await serializeSignedCookie(name, value, process.env.BETTER_AUTH_SECRET!);
  return serialized.split(';')[0]!;
}

async function viewAs(callerToken: string | null, body: unknown) {
  return auth.handler(
    new Request(`${BASE}/admin/impersonate-user`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        ...(callerToken
          ? { cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, callerToken) }
          : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

/** Whether the endpoint itself ran far enough to look the target up. */
const endpointLookedUp = (id: string) =>
  mocks.client.user.findFirst.mock.calls.some(([args]: any[]) => args?.where?.id === id);

beforeEach(() => {
  mocks.state.sessions = [];
  mocks.state.created = [];
  vi.clearAllMocks();
});

describe('roleIncludesAdmin', () => {
  it.each([
    ['admin', true],
    ['Admin', true],
    ['user,admin', true],
    ['user, ADMIN ', true],
    ['user', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%j → %s', (role, expected) => {
    expect(roleIncludesAdmin(role)).toBe(expected);
  });
});

// Who may start "view as" at all: platform admins only, by id. A user's role
// plays no part (role-admin's role is `admin`).
describe('mayViewAs', () => {
  it.each([
    ['admin-1', true],
    ['admin-2', true],
    ['12345', true],
    ['role-admin', false],
    ['role-mixed', false],
    ['owner-1', false],
    ['', false],
  ])('%j → %s', (userId, expected) => {
    expect(mayViewAs(userId)).toBe(expected);
  });
});

describe('a platform admin viewing as someone (hooks.before)', () => {
  it.each([
    ['another platform admin', 'admin-2'],
    ['a user whose role is admin', 'role-admin'],
    ['a user whose role list contains Admin', 'role-mixed'],
  ])('is refused for %s, before the endpoint runs', async (_label, target) => {
    const res = await viewAs(signIn('admin-1'), { userId: target });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: VIEW_AS_ADMIN_REFUSED_MESSAGE });
    expect(mocks.state.created).toHaveLength(0);
    expect(endpointLookedUp(target)).toBe(false);
  });

  // The endpoint reads `userId` with z.coerce.string(), so these name the
  // same user as the plain string does.
  it.each([
    ['a one-element array', ['admin-2']],
    ['a number', 12345],
  ])('reads the target id sent as %s the way the endpoint does', async (_label, userId) => {
    const res = await viewAs(signIn('admin-1'), { userId });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: VIEW_AS_ADMIN_REFUSED_MESSAGE });
    expect(mocks.state.created).toHaveLength(0);
  });

  it('works for an ordinary user, and stopping returns the admin session', async () => {
    const adminToken = signIn('admin-1');
    const res = await viewAs(adminToken, { userId: 'owner-1' });

    expect(res.status).toBe(200);
    expect(mocks.state.created).toHaveLength(1);
    expect(mocks.state.created[0]).toMatchObject({ user_id: 'owner-1', impersonatedBy: 'admin-1' });

    // Stop viewing: the impersonated session goes, the admin's comes back.
    const viewing = mocks.state.created[0]!.token as string;
    const stop = await auth.handler(
      new Request(`${BASE}/admin/stop-impersonating`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: [
            await signedCookie(`${COOKIE_PREFIX}.session_token`, viewing),
            await signedCookie(`${COOKIE_PREFIX}.admin_session`, `${adminToken}:`),
          ].join('; '),
        },
        body: '{}',
      })
    );
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ user: { id: 'admin-1' } });
    expect(mocks.state.sessions.some(s => s.token === viewing)).toBe(false);
  });
});

describe('callers who may not view as anyone', () => {
  // Only a platform admin's target is looked up, so every other caller gets
  // the same answer whoever the target is.
  it('signed out: the same 401 for an admin target and an ordinary one', async () => {
    const admin = await viewAs(null, { userId: 'admin-2' });
    const ordinary = await viewAs(null, { userId: 'owner-1' });

    expect(admin.status).toBe(401);
    expect(ordinary.status).toBe(401);
    expect(await admin.text()).toBe(await ordinary.text());
  });

  it('signed in without an admin role: the same refusal for both', async () => {
    const token = signIn('owner-1');
    const admin = await viewAs(token, { userId: 'admin-2' });
    const ordinary = await viewAs(token, { userId: 'student-1' });

    expect(admin.status).toBe(403);
    expect(ordinary.status).toBe(403);
    const adminBody = await admin.json();
    expect(adminBody).toEqual(await ordinary.json());
    expect(adminBody.message).toBe(VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE);
    expect(mocks.client.user.findUnique).not.toHaveBeenCalled();
  });

  // The admin plugin on its own lets a user whose role is `admin` view as
  // anyone who is not an admin.
  it('signed in with the admin role but not a platform admin: the same refusal for both', async () => {
    const token = signIn('role-admin');
    const admin = await viewAs(token, { userId: 'admin-1' });
    const ordinary = await viewAs(token, { userId: 'student-1' });

    expect(admin.status).toBe(403);
    expect(ordinary.status).toBe(403);
    const adminBody = await admin.json();
    expect(adminBody).toEqual(await ordinary.json());
    expect(adminBody.message).toBe(VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE);
    expect(mocks.client.user.findUnique).not.toHaveBeenCalled();
    expect(endpointLookedUp('student-1')).toBe(false);
    expect(mocks.state.created).toHaveLength(0);
  });

  // `user,Admin` is protected as a target (role contains "admin"), but the
  // admin plugin matches the role name exactly, so it cannot view as anyone.
  it('signed in with a role that only contains "admin": the same refusal for both', async () => {
    const token = signIn('role-mixed');
    const admin = await viewAs(token, { userId: 'admin-2' });
    const ordinary = await viewAs(token, { userId: 'student-1' });

    expect(admin.status).toBe(403);
    expect(ordinary.status).toBe(403);
    const adminBody = await admin.json();
    expect(adminBody).toEqual(await ordinary.json());
    expect(adminBody.message).toBe(VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE);
    expect(mocks.client.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.state.created).toHaveLength(0);
  });
});

describe('creating an impersonated session (databaseHooks.session.create.before)', () => {
  // Straight through the internal adapter: no endpoint and no hooks.before,
  // so only the database hook stands between this call and the session.
  const createSession = async (userId: string, impersonatedBy?: string) =>
    (await auth.$context).internalAdapter.createSession(
      userId,
      false,
      impersonatedBy ? { impersonatedBy } : undefined
    );

  it.each([
    ['a platform admin', 'admin-2'],
    ['a user whose role contains admin', 'role-mixed'],
  ])('is refused for %s', async (_label, target) => {
    await expect(createSession(target, 'admin-1')).rejects.toMatchObject({
      statusCode: 403,
      body: { message: VIEW_AS_ADMIN_REFUSED_MESSAGE },
    });
    expect(mocks.state.created).toHaveLength(0);
  });

  it.each([
    ['a user whose role is admin', 'role-admin'],
    ['an ordinary user', 'owner-1'],
  ])('is refused when the viewer is %s, not a platform admin', async (_label, viewer) => {
    await expect(createSession('student-1', viewer)).rejects.toMatchObject({
      statusCode: 403,
      body: { message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE },
    });
    expect(mocks.state.created).toHaveLength(0);
  });

  it('is allowed for an ordinary user', async () => {
    await createSession('owner-1', 'admin-1');
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ user_id: 'owner-1', impersonatedBy: 'admin-1' }),
    ]);
  });

  it("leaves an admin's own sign-in alone", async () => {
    await createSession('admin-2');
    expect(mocks.state.created).toEqual([expect.objectContaining({ user_id: 'admin-2' })]);
    expect(mocks.client.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('linking or unlinking a sign-in account while viewing as someone', () => {
  /** A session for `userId` that platform admin `admin-1` is viewing as. */
  function viewingAs(userId: string): string {
    const token = `viewing-${userId}`;
    mocks.state.sessions.push({
      id: `sess-viewing-${userId}`,
      token,
      user_id: userId,
      expires_at: new Date(Date.now() + 3_600_000),
      created_at: new Date(),
      updated_at: new Date(),
      ip_address: null,
      user_agent: null,
      impersonatedBy: 'admin-1',
    });
    return token;
  }

  async function post(path: string, token: string, body: unknown) {
    return auth.handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, token),
        },
        body: JSON.stringify(body),
      })
    );
  }

  const PATHS: Array<[string, Record<string, unknown>]> = [
    ['/link-social', { provider: 'github', callbackURL: '/settings/connections' }],
    [
      '/gitlab-instance/link',
      { instanceId: 'inst-1', callbackURL: '/settings', errorCallbackURL: '/settings' },
    ],
    ['/unlink-account', { providerId: 'github' }],
  ];

  it.each(PATHS)('refuses %s with a 403', async (path, body) => {
    const res = await post(path, viewingAs('student-1'), body);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: ACCOUNT_LINK_VIEWING_AS_MESSAGE });
    expect(mocks.client.account.findMany).not.toHaveBeenCalled();
    expect(mocks.client.account.create).not.toHaveBeenCalled();
    expect(mocks.client.account.delete).not.toHaveBeenCalled();
  });

  it.each(PATHS)('leaves %s to its endpoint for a normal session', async (path, body) => {
    const res = await post(path, signIn('student-1'), body);

    expect(await res.text()).not.toContain(ACCOUNT_LINK_VIEWING_AS_MESSAGE);
  });

  it('lets a normal session reach the unlink endpoint itself', async () => {
    // better-auth 1.7 names the account by id as well as provider.
    await post('/unlink-account', signIn('student-1'), {
      providerId: 'github',
      accountId: 'gh-1',
    });

    // The endpoint lists the user's accounts before unlinking one.
    expect(mocks.client.account.findMany).toHaveBeenCalled();
  });
});

describe('auditing View as on the server (PlatformAuditLog)', () => {
  const auditRows = () =>
    mocks.client.platformAuditLog.create.mock.calls.map(([args]: any[]) => args.data);

  async function stop(viewingToken: string, adminToken: string) {
    return auth.handler(
      new Request(`${BASE}/admin/stop-impersonating`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: [
            await signedCookie(`${COOKIE_PREFIX}.session_token`, viewingToken),
            await signedCookie(`${COOKIE_PREFIX}.admin_session`, `${adminToken}:`),
          ].join('; '),
        },
        body: '{}',
      })
    );
  }

  it('writes one start row when View as starts and one end row when it stops', async () => {
    const adminToken = signIn('admin-1');

    expect((await viewAs(adminToken, { userId: 'owner-1' })).status).toBe(200);
    const viewing = mocks.state.created[0]!;
    expect(auditRows()).toEqual([
      {
        actor_id: 'admin-1',
        action: 'impersonate.start',
        target_type: 'user',
        target_id: 'owner-1',
        data: expect.objectContaining({
          tool: 'auth:view_as.start',
          sessionId: viewing.id,
          path: '/admin/impersonate-user',
        }),
      },
    ]);

    expect((await stop(viewing.token, adminToken)).status).toBe(200);
    expect(auditRows()).toHaveLength(2);
    expect(auditRows()[1]).toEqual({
      // One end row per session: its id comes from the session id.
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      actor_id: 'admin-1',
      action: 'impersonate.end',
      target_type: 'user',
      target_id: 'owner-1',
      data: expect.objectContaining({
        tool: 'auth:view_as.end',
        sessionId: viewing.id,
        path: '/admin/stop-impersonating',
        endedBy: 'admin',
      }),
    });
  });

  it('writes no row for a refused start', async () => {
    const res = await viewAs(signIn('admin-1'), { userId: 'admin-2' });
    expect(res.status).toBe(403);

    const roleAdmin = await viewAs(signIn('role-admin'), { userId: 'student-1' });
    expect(roleAdmin.status).toBe(403);

    // The database hook's own refusal, with no endpoint in front of it.
    await expect(
      (await auth.$context).internalAdapter.createSession('student-1', false, {
        impersonatedBy: 'role-admin',
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(mocks.client.platformAuditLog.create).not.toHaveBeenCalled();
  });

  it("writes no row for an ordinary session's sign-in or sign-out", async () => {
    await (await auth.$context).internalAdapter.createSession('owner-1', false);
    const token = signIn('owner-1');
    const res = await auth.handler(
      new Request(`${BASE}/sign-out`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, token),
        },
        body: '{}',
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.client.platformAuditLog.create).not.toHaveBeenCalled();
  });

  it('writes an end row when the viewing-as session signs out', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = mocks.state.created[0]!;

    const res = await auth.handler(
      new Request(`${BASE}/sign-out`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, viewing.token),
        },
        body: '{}',
      })
    );

    expect(res.status).toBe(200);
    expect(auditRows().map((row: any) => [row.action, row.data.path])).toEqual([
      ['impersonate.start', '/admin/impersonate-user'],
      ['impersonate.end', '/sign-out'],
    ]);
    expect(auditRows()[1].data.endedBy).toBe('admin');
  });

  it('records the viewed user as the one who ended it when they sign out their own sessions', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = mocks.state.created[0]!;
    const ownerToken = signIn('owner-1');

    const res = await auth.handler(
      new Request(`${BASE}/revoke-sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, ownerToken),
        },
        body: '{}',
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.state.sessions.some(s => s.token === viewing.token)).toBe(false);
    expect(auditRows()).toHaveLength(2);
    expect(auditRows()[1]).toMatchObject({
      actor_id: 'admin-1',
      action: 'impersonate.end',
      target_id: 'owner-1',
      data: { sessionId: viewing.id, path: '/revoke-sessions', endedBy: 'user' },
    });
  });

  it('records the system as the one who ended it when its expired row is cleaned up', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = mocks.state.created[0]!;
    viewing.expires_at = new Date(Date.now() - 1_000);

    const res = await auth.handler(
      new Request(`${BASE}/get-session`, {
        headers: { cookie: await signedCookie(`${COOKIE_PREFIX}.session_token`, viewing.token) },
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(mocks.state.sessions.some(s => s.token === viewing.token)).toBe(false);
    expect(auditRows()[1]).toMatchObject({
      action: 'impersonate.end',
      data: { path: '/get-session', endedBy: 'system' },
    });
  });

  it('records the system when a stop finds the viewing row already expired', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = mocks.state.created[0]!;
    viewing.expires_at = new Date(Date.now() - 1_000);

    await stop(viewing.token, adminToken);

    expect(mocks.state.sessions.some(s => s.token === viewing.token)).toBe(false);
    expect(auditRows()[1]).toMatchObject({
      action: 'impersonate.end',
      data: { path: '/admin/stop-impersonating', endedBy: 'system' },
    });
  });

  it('still stops when the end row cannot be written', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = mocks.state.created[0]!;
    mocks.client.platformAuditLog.create.mockRejectedValueOnce(new Error('database down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await stop(viewing.token, adminToken);

    expect(res.status).toBe(200);
    expect(mocks.state.sessions.some(s => s.token === viewing.token)).toBe(false);
    errors.mockRestore();
  });

  // Stop sent twice (a double click, two tabs): both requests read the
  // viewing row before either deletes it, and each runs the delete hook.
  it('writes one end row when two stops of the same session run at once', async () => {
    const adminToken = signIn('admin-1');
    await viewAs(adminToken, { userId: 'owner-1' });
    const viewing = { ...mocks.state.created[0]! };
    const stored = new Map<string, Record<string, unknown>>();
    const create = mocks.client.platformAuditLog.create;
    const findFirst = mocks.client.session.findFirst;
    const findMany = mocks.client.session.findMany;
    const originals = [create, findFirst, findMany].map(fn => fn.getMockImplementation());
    create.mockImplementation(({ data }: any) => {
      if (data.id && stored.has(data.id)) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        );
      }
      stored.set(data.id ?? `row-${stored.size}`, data);
      return Promise.resolve(data);
    });
    // The row as both requests read it, before either deleted it.
    const stale = (where: any) => (where?.token === viewing.token ? viewing : null);
    findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        stale(where) ?? mocks.state.sessions.find(r => r.token === where?.token) ?? null
      )
    );
    findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        stale(where) ? [viewing] : mocks.state.sessions.filter(r => r.token === where?.token)
      )
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await Promise.all([
        stop(viewing.token, adminToken),
        stop(viewing.token, adminToken),
      ]);

      expect(results.map(r => r.status)).toEqual([200, 200]);
      const endWrites = create.mock.calls
        .map(([args]: any[]) => args.data)
        .filter((data: any) => data.action === 'impersonate.end');
      expect(endWrites).toHaveLength(2);
      expect(endWrites[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(endWrites[1].id).toBe(endWrites[0].id);
      // The start was written before this stand-in; one end row was kept.
      expect([...stored.values()].map((data: any) => data.action)).toEqual(['impersonate.end']);
      // The duplicate is expected, not an error.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      [create, findFirst, findMany].forEach((fn, i) => fn.mockImplementation(originals[i]!));
      errors.mockRestore();
    }
  });

  it('gives each session its own end row id', async () => {
    const adminToken = signIn('admin-1');
    for (const userId of ['owner-1', 'student-1']) {
      await viewAs(adminToken, { userId });
      const viewing = mocks.state.created.at(-1)!;
      expect((await stop(viewing.token, adminToken)).status).toBe(200);
    }

    const ids = auditRows()
      .filter((data: any) => data.action === 'impersonate.end')
      .map((data: any) => data.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not hand out a View as session whose start cannot be written', async () => {
    mocks.client.platformAuditLog.create.mockRejectedValueOnce(new Error('database down'));

    const res = await viewAs(signIn('admin-1'), { userId: 'owner-1' });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.getSetCookie().join(';')).not.toContain(`${COOKIE_PREFIX}.session_token=`);
  });

  it('removes the View as session row whose start cannot be written, and records no end', async () => {
    mocks.client.platformAuditLog.create.mockRejectedValueOnce(new Error('database down'));

    const res = await viewAs(signIn('admin-1'), { userId: 'owner-1' });

    expect(res.status).toBeGreaterThanOrEqual(500);
    const created = mocks.state.created[0]!;
    expect(created).toMatchObject({ user_id: 'owner-1', impersonatedBy: 'admin-1' });
    expect(mocks.client.session.deleteMany).toHaveBeenCalledWith({ where: { id: created.id } });
    expect(mocks.state.sessions.filter(s => s.impersonatedBy)).toEqual([]);
    // The admin's own session stays.
    expect(mocks.state.sessions.map(s => s.user_id)).toEqual(['admin-1']);
    // Only the failed start was attempted: no end row for the removed session.
    expect(
      mocks.client.platformAuditLog.create.mock.calls.map(([args]: any[]) => args.data.action)
    ).toEqual(['impersonate.start']);
  });

  it('still fails the start when the row cannot be removed either', async () => {
    mocks.client.platformAuditLog.create.mockRejectedValueOnce(new Error('database down'));
    mocks.client.session.deleteMany.mockRejectedValueOnce(new Error('database down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await viewAs(signIn('admin-1'), { userId: 'owner-1' });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.getSetCookie().join(';')).not.toContain(`${COOKIE_PREFIX}.session_token=`);
    expect(errors).toHaveBeenCalledWith('[auth] View as session not removed', expect.any(Error));
    errors.mockRestore();
  });
});
