/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * "View as" (better-auth admin impersonation, POST /admin/impersonate-user)
 * never targets an admin: neither a platform admin (PLATFORM_ADMIN_USER_IDS)
 * nor a user whose role contains "admin". Through the REAL exported `auth`,
 * over `auth.handler`; only Prisma and the service layer are stood in.
 *
 * Two layers, each tested on its own:
 *   (a) `hooks.before` refuses the request before the endpoint runs, with its
 *       own message (1.4.18's endpoint also refuses admin targets, with
 *       "You cannot impersonate admins"; from 1.5 it lets an `adminUserIds`
 *       caller through, so the message tells the layers apart);
 *   (b) `databaseHooks.session.create.before` refuses any session created
 *       with `impersonatedBy` for an admin, whatever path creates it.
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
  for (const model of ['account', 'verification', 'oauthAccessToken', 'oauthApplication']) {
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
      state.sessions = state.sessions.filter(s => s.token !== where?.token);
      return Promise.resolve({ count: before - state.sessions.length });
    }),
  };
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  return { state, users, client };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const { auth, COOKIE_PREFIX, VIEW_AS_ADMIN_REFUSED_MESSAGE, roleIncludesAdmin } =
  await import('../server.ts');

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

  it('is refused for a caller whose role is admin, too', async () => {
    const res = await viewAs(signIn('role-admin'), { userId: 'admin-1' });

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
  // The target is checked only for a caller the endpoint would let through,
  // so the answer is the endpoint's own and the same for an admin target.
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
    expect(adminBody.message).not.toBe(VIEW_AS_ADMIN_REFUSED_MESSAGE);
    expect(mocks.client.user.findUnique).not.toHaveBeenCalled();
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
