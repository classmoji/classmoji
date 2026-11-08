/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * The "view as" rules in `hooks.before` read the request's session two ways:
 * from the `session_data` cookie cache and from the database row the
 * `session_token` cookie names, and endpoints differ in which one they read
 * (several take `?disableCookieCache` from the query). Each rule refuses when
 * either read is viewing as someone.
 *
 * better-auth 1.7 uses the cache only when its session's token is the
 * `session_token` cookie's (api/routes/session.mjs:57), so a jar whose two
 * cookies name different sessions is read as the token's session both ways.
 * 1.4 read them independently; the mixed jars below pin the 1.7 reading.
 *
 * Through the REAL exported `auth`, over `auth.handler`; only Prisma and the
 * service layer are stood in. The cookie jars:
 *   - viewing as:  the viewing-as session's token and its own cache;
 *   - token-mixed: the viewing-as session's token with the admin's own cache;
 *   - cache-mixed: the admin's own token with the viewing-as session's cache;
 *   - own:         the admin's own token and cache (not viewing as anyone).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1,admin-2';

const mocks = vi.hoisted(() => {
  const user = (id: string, role: string | null = null) => ({
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
    'admin-1': user('admin-1'),
    'admin-2': user('admin-2'),
    'student-1': user('student-1'),
    'role-admin': user('role-admin', 'admin'),
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
    'oauthConsent',
    'platformAuditLog',
  ]) {
    client[model] = noop();
  }
  client.user = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) => Promise.resolve(users[where?.id] ?? null)),
    findUnique: vi.fn(({ where }: any) => Promise.resolve(users[where?.id] ?? null)),
  };
  client.session = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(state.sessions.find(row => row.token === where?.token) ?? null)
    ),
    findMany: vi.fn(({ where }: any) =>
      Promise.resolve(state.sessions.filter(row => row.token === where?.token))
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
  ACCOUNT_CHANGE_VIEWING_AS_MESSAGE,
  ACCOUNT_LINK_VIEWING_AS_MESSAGE,
  auth,
  COOKIE_PREFIX,
  CONNECT_APP_VIEWING_AS_MESSAGE,
  VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE,
  isViewingAsAnotherUser,
} = await import('../server.ts');

const BASE = 'http://localhost:3000/api/auth';
const SECRET = process.env.BETTER_AUTH_SECRET!;
const ADMIN_TOKEN = 'token-admin-1';
const VIEWING_TOKEN = 'token-viewing-student-1';

const signed = async (name: string, value: string) =>
  (await serializeSignedCookie(name, value, SECRET)).split(';')[0]!;
const tokenCookie = (token: string) => signed(`${COOKIE_PREFIX}.session_token`, token);

function addSession(token: string, userId: string, impersonatedBy: string | null, ttlMs: number) {
  mocks.state.sessions.push({
    id: `sess-${token}`,
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + ttlMs),
    created_at: new Date(),
    updated_at: new Date(),
    ip_address: null,
    user_agent: null,
    impersonatedBy,
  });
}

/** The `session_data` cookie better-auth issues for `token` (minted through /get-session). */
async function cacheCookieFor(token: string): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE}/get-session`, { headers: { cookie: await tokenCookie(token) } })
  );
  const pair = res.headers
    .getSetCookie()
    .map(header => header.split(';')[0]!)
    .find(p => p.startsWith(`${COOKIE_PREFIX}.session_data=`));
  if (!pair) throw new Error(`no session_data issued for ${token}`);
  return pair;
}

type Jars = Record<'viewingAs' | 'tokenMixed' | 'cacheMixed' | 'own', string>;

/** The admin signed in, then viewing as student-1, with both caches kept. */
async function jars(): Promise<Jars> {
  addSession(ADMIN_TOKEN, 'admin-1', null, 7 * 86_400_000);
  addSession(VIEWING_TOKEN, 'student-1', 'admin-1', 3_600_000);
  const adminCache = await cacheCookieFor(ADMIN_TOKEN);
  const viewingCache = await cacheCookieFor(VIEWING_TOKEN);
  const adminToken = await tokenCookie(ADMIN_TOKEN);
  const viewingToken = await tokenCookie(VIEWING_TOKEN);
  vi.clearAllMocks();
  return {
    viewingAs: `${viewingToken}; ${viewingCache}`,
    tokenMixed: `${viewingToken}; ${adminCache}`,
    cacheMixed: `${adminToken}; ${viewingCache}`,
    own: `${adminToken}; ${adminCache}`,
  };
}

async function post(path: string, cookie: string, body: unknown = {}) {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  mocks.state.sessions = [];
  mocks.state.created = [];
  vi.clearAllMocks();
});

// The jars whose session_token names the viewing-as session.
const VIEWING_JARS = ['viewingAs', 'tokenMixed'] as const;

describe('the two session reads', () => {
  it("ignore a cache whose token isn't the session cookie's", async () => {
    const j = await jars();
    const read = async (cookie: string, disableCookieCache: boolean) =>
      (
        await auth.api.getSession({
          headers: new Headers({ cookie }),
          query: { disableRefresh: true, disableCookieCache },
        })
      )?.user.id;

    // Both reads are the token's session, whichever cache rides along.
    expect([await read(j.tokenMixed, false), await read(j.tokenMixed, true)]).toEqual([
      'student-1',
      'student-1',
    ]);
    expect([await read(j.cacheMixed, false), await read(j.cacheMixed, true)]).toEqual([
      'admin-1',
      'admin-1',
    ]);
    // A matching cache is still used: no database read for it.
    mocks.client.session.findFirst.mockClear();
    expect(await read(j.viewingAs, false)).toBe('student-1');
    expect(mocks.client.session.findFirst).not.toHaveBeenCalled();
  });
});

describe('linking or unlinking a sign-in account', () => {
  const LINK_PATHS: Array<[string, Record<string, unknown>]> = [
    ['/link-social?disableCookieCache=true', { provider: 'github', callbackURL: '/settings' }],
    ['/link-social', { provider: 'github', callbackURL: '/settings' }],
    ['/unlink-account?disableCookieCache=true', { providerId: 'github', accountId: 'gh-1' }],
    ['/unlink-account', { providerId: 'github', accountId: 'gh-1' }],
    [
      '/gitlab-instance/link',
      { instanceId: 'inst-1', callbackURL: '/settings', errorCallbackURL: '/settings' },
    ],
  ];

  for (const jar of VIEWING_JARS) {
    it.each(LINK_PATHS)(`refuses %s for the ${jar} jar`, async (path, body) => {
      const j = await jars();

      const res = await post(path, j[jar], body);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: ACCOUNT_LINK_VIEWING_AS_MESSAGE });
      expect(mocks.client.account.findMany).not.toHaveBeenCalled();
      expect(mocks.client.account.delete).not.toHaveBeenCalled();
      expect(mocks.client.verification.create).not.toHaveBeenCalled();
    });
  }

  it.each(LINK_PATHS)('leaves %s to its endpoint for the own jar', async (path, body) => {
    const j = await jars();

    const res = await post(path, j.own, body);

    expect(await res.text()).not.toContain(ACCOUNT_LINK_VIEWING_AS_MESSAGE);
  });

  // The admin's own token with the viewing-as session's cache: better-auth
  // reads the token's session, so the endpoint acts on the admin's own
  // account and never on the viewed user's.
  it.each(LINK_PATHS)(
    "leaves %s acting on the admin's own account for the cacheMixed jar",
    async (path, body) => {
      const j = await jars();

      const res = await post(path, j.cacheMixed, body);

      expect(await res.text()).not.toContain(ACCOUNT_LINK_VIEWING_AS_MESSAGE);
      const accountReads = mocks.client.account.findMany.mock.calls.map(
        ([args]: any[]) => args?.where?.user_id
      );
      expect(accountReads).not.toContain('student-1');
      expect(mocks.client.account.delete).not.toHaveBeenCalled();
    }
  );

  it('lets the own jar reach the unlink endpoint, and adds no session cookie of its own', async () => {
    const j = await jars();

    const res = await post('/unlink-account?disableCookieCache=true', j.own, {
      providerId: 'github',
      accountId: 'gh-1',
    });

    // The endpoint lists the user's accounts before unlinking one.
    expect(mocks.client.account.findMany).toHaveBeenCalled();
    // No session_token cookie: the hook's reads refresh nothing. (better-auth
    // 1.7's own read for the endpoint sets the session_data cache again after
    // a database read.)
    expect(
      res.headers.getSetCookie().filter(c => c.startsWith(`${COOKIE_PREFIX}.session_token=`))
    ).toEqual([]);
  });
});

describe('changing a password, profile or sessions', () => {
  const CHANGE_PATHS: Array<[string, Record<string, unknown>]> = [
    ['/change-password', { currentPassword: 'old-password', newPassword: 'new-password' }],
    [
      '/change-password?disableCookieCache=true',
      { currentPassword: 'old-password', newPassword: 'new-password', revokeOtherSessions: true },
    ],
    ['/update-user', { name: 'Renamed' }],
    ['/update-user?disableCookieCache=true', { image: 'https://example.com/a.png' }],
    ['/revoke-session', { token: ADMIN_TOKEN }],
    ['/revoke-sessions', {}],
    ['/revoke-other-sessions', {}],
  ];

  for (const jar of VIEWING_JARS) {
    it.each(CHANGE_PATHS)(`refuses %s for the ${jar} jar`, async (path, body) => {
      const j = await jars();
      const sessionsBefore = mocks.state.sessions.length;

      const res = await post(path, j[jar], body);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: ACCOUNT_CHANGE_VIEWING_AS_MESSAGE });
      expect(mocks.client.user.update).not.toHaveBeenCalled();
      expect(mocks.client.account.findMany).not.toHaveBeenCalled();
      expect(mocks.state.sessions).toHaveLength(sessionsBefore);
    });
  }

  // The admin's own token with the viewing-as session's cache: the change,
  // if made, is the admin's own.
  it.each(CHANGE_PATHS)(
    'leaves %s acting on the admin for the cacheMixed jar',
    async (path, body) => {
      const j = await jars();

      const res = await post(path, j.cacheMixed, body);

      expect(await res.text()).not.toContain(ACCOUNT_CHANGE_VIEWING_AS_MESSAGE);
      for (const [args] of mocks.client.user.update.mock.calls as any[]) {
        expect(args?.where?.id).toBe('admin-1');
      }
      // The viewing-as session is left alone.
      expect(mocks.state.sessions.some(s => s.token === VIEWING_TOKEN)).toBe(true);
    }
  );

  it('lets the own jar change its own name', async () => {
    const j = await jars();

    const res = await post('/update-user', j.own, { name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(mocks.client.user.update).toHaveBeenCalled();
  });

  it('keeps stopping View as open while viewing as someone', async () => {
    const j = await jars();
    const adminSession = await signed(`${COOKIE_PREFIX}.admin_session`, `${ADMIN_TOKEN}:`);

    const res = await post('/admin/stop-impersonating', `${j.viewingAs}; ${adminSession}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: 'admin-1' } });
    expect(mocks.state.sessions.some(s => s.token === VIEWING_TOKEN)).toBe(false);
  });
});

describe('connecting an app', () => {
  for (const jar of VIEWING_JARS) {
    it(`refuses approving consent for the ${jar} jar`, async () => {
      const j = await jars();

      const res = await post('/oauth2/consent?disableCookieCache=true', j[jar], {
        accept: true,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'access_denied',
        error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
      });
      expect(mocks.client.oauthConsent.create).not.toHaveBeenCalled();
    });
  }

  // The admin's own token with the viewing-as session's cache: approving is
  // the admin's own, and writes nothing for the viewed user.
  it('leaves approving consent to the admin for the cacheMixed jar', async () => {
    const j = await jars();

    const res = await post('/oauth2/consent?disableCookieCache=true', j.cacheMixed, {
      accept: true,
    });

    expect(await res.text()).not.toContain(CONNECT_APP_VIEWING_AS_MESSAGE);
    for (const [args] of mocks.client.oauthConsent.create.mock.calls as any[]) {
      expect(args?.data?.userId).toBe('admin-1');
    }
  });

  it('lets the own jar through to the consent endpoint', async () => {
    const j = await jars();

    const res = await post('/oauth2/consent?disableCookieCache=true', j.own, {
      accept: true,
    });

    expect(await res.text()).not.toContain(CONNECT_APP_VIEWING_AS_MESSAGE);
  });
});

describe('starting to view as someone', () => {
  it('is refused for a caller whose two reads are not both a platform admin not viewing as anyone', async () => {
    const j = await jars();

    for (const cookie of [j.viewingAs, j.tokenMixed]) {
      const res = await post('/admin/impersonate-user', cookie, { userId: 'student-1' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE });
    }
    expect(mocks.state.created).toHaveLength(0);
  });

  // The admin's own token with the viewing-as session's cache: the start is
  // the token's admin's, from their own session.
  it('uses the session the token names for the cacheMixed jar', async () => {
    const j = await jars();

    const res = await post('/admin/impersonate-user', j.cacheMixed, { userId: 'student-1' });

    expect(res.status).toBe(200);
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ user_id: 'student-1', impersonatedBy: 'admin-1' }),
    ]);
  });

  it('works for the own jar', async () => {
    const j = await jars();

    const res = await post('/admin/impersonate-user', j.own, { userId: 'student-1' });

    expect(res.status).toBe(200);
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ user_id: 'student-1', impersonatedBy: 'admin-1' }),
    ]);
  });

  // The endpoint reads the cookie cache, which a platform admin's browser
  // keeps after the session row is gone (signed out elsewhere, revoked).
  it("is refused for a platform admin's cache whose session row is gone", async () => {
    const j = await jars();
    mocks.state.sessions = mocks.state.sessions.filter(s => s.token !== ADMIN_TOKEN);

    const cached = await auth.api.getSession({
      headers: new Headers({ cookie: j.own }),
      query: { disableRefresh: true },
    });
    expect(cached?.user.id).toBe('admin-1');

    const res = await post('/admin/impersonate-user', j.own, { userId: 'student-1' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE });
    expect(mocks.state.created).toHaveLength(0);
    expect(mocks.client.platformAuditLog.create).not.toHaveBeenCalled();
  });

  // A cache naming another platform admin is ignored: the start is the
  // token's admin's.
  it("starts as the token's admin when the cache names another platform admin", async () => {
    addSession(ADMIN_TOKEN, 'admin-1', null, 7 * 86_400_000);
    addSession('token-admin-2', 'admin-2', null, 7 * 86_400_000);
    const otherAdminCache = await cacheCookieFor('token-admin-2');
    const adminCache = await cacheCookieFor(ADMIN_TOKEN);
    vi.clearAllMocks();

    for (const [cookie, admin] of [
      [`${await tokenCookie(ADMIN_TOKEN)}; ${otherAdminCache}`, 'admin-1'],
      [`${await tokenCookie('token-admin-2')}; ${adminCache}`, 'admin-2'],
    ] as const) {
      mocks.state.created = [];
      const res = await post('/admin/impersonate-user', cookie, { userId: 'student-1' });
      expect(res.status).toBe(200);
      expect(mocks.state.created).toEqual([
        expect.objectContaining({ user_id: 'student-1', impersonatedBy: admin }),
      ]);
    }
  });

  it("leaves a request with neither read to the endpoint's own 401", async () => {
    const res = await post('/admin/impersonate-user', await tokenCookie('token-no-such-row'), {
      userId: 'student-1',
    });

    expect(res.status).toBe(401);
    expect(mocks.state.created).toHaveLength(0);
  });
});

describe('the expiry of a View as session', () => {
  const read = async (token: string) =>
    auth.handler(
      new Request(`${BASE}/get-session?disableCookieCache=true`, {
        headers: { cookie: await tokenCookie(token) },
      })
    );
  const maxAge = (res: Response) =>
    Number(
      res.headers
        .getSetCookie()
        .find(c => c.startsWith(`${COOKIE_PREFIX}.session_token=`))
        ?.match(/Max-Age=(\d+)/i)?.[1]
    );
  const updatedExpiry = () =>
    (mocks.client.session.update.mock.calls.at(-1)?.[0] as any)?.data?.expires_at as Date;

  // The browser keeps the dont_remember cookie while viewing as someone,
  // which skips the refresh; a request without it reaches the refresh.
  it('stays put on a database read without dont_remember that is due a refresh', async () => {
    addSession(VIEWING_TOKEN, 'student-1', 'admin-1', 3_600_000);
    const expiresAt = mocks.state.sessions[0]!.expires_at as Date;

    const res = await read(VIEWING_TOKEN);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      session: { userId: 'student-1', impersonatedBy: 'admin-1' },
      user: { id: 'student-1' },
    });
    expect(mocks.client.session.update).toHaveBeenCalledTimes(1);
    expect(updatedExpiry().getTime()).toBe(expiresAt.getTime());
    // The cookie is set again with the time the session has left.
    // better-auth 1.7 sets the session cookie again for session.expiresIn
    // (api/routes/session.mjs:203-206), whatever the row's expiry; the
    // session ends with its row, which the next test pins.
    expect(maxAge(res)).toBe(7 * 86_400);
  });

  it('ends at its pinned expiry, whatever the cookie says', async () => {
    addSession(VIEWING_TOKEN, 'student-1', 'admin-1', 3_600_000);
    const res = await read(VIEWING_TOKEN);
    expect(res.status).toBe(200);
    const cache = res.headers
      .getSetCookie()
      .map(header => header.split(';')[0]!)
      .find(p => p.startsWith(`${COOKIE_PREFIX}.session_data=`));
    const cookie = [await tokenCookie(VIEWING_TOKEN), ...(cache ? [cache] : [])].join('; ');

    vi.useFakeTimers({ now: Date.now() + 3_600_000 + 1_000 });
    try {
      const later = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableRefresh: true },
      });
      expect(later).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // A refresh made by an endpoint's own session read (sessionMiddleware), not
  // by /get-session: the expiry is pinned there too.
  it('stays put on a nested read that is due a refresh (/list-accounts)', async () => {
    addSession(VIEWING_TOKEN, 'student-1', 'admin-1', 3_600_000);
    const expiresAt = mocks.state.sessions[0]!.expires_at as Date;

    const res = await auth.handler(
      new Request(`${BASE}/list-accounts`, {
        headers: { cookie: await tokenCookie(VIEWING_TOKEN) },
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.client.session.update).toHaveBeenCalledTimes(1);
    expect(updatedExpiry().getTime()).toBe(expiresAt.getTime());
  });

  it('still extends an ordinary session that is due a refresh', async () => {
    addSession('token-due', 'admin-1', null, 2 * 86_400_000);

    const res = await read('token-due');

    expect(res.status).toBe(200);
    expect(mocks.client.session.update).toHaveBeenCalledTimes(1);
    const sevenDays = 7 * 86_400_000;
    expect(updatedExpiry().getTime()).toBeGreaterThan(Date.now() + sevenDays - 60_000);
    expect(maxAge(res)).toBeGreaterThan(sevenDays / 1000 - 60);
  });
});

describe('isViewingAsAnotherUser', () => {
  it('is true for every viewing-as jar and false for the own jar and no session', async () => {
    const j = await jars();
    const check = (cookie: string) => isViewingAsAnotherUser(new Headers({ cookie }));

    expect(await check(j.viewingAs)).toBe(true);
    expect(await check(j.tokenMixed)).toBe(true);
    // The admin's own token: the viewing-as cache beside it is not read.
    expect(await check(j.cacheMixed)).toBe(false);
    expect(await check(j.own)).toBe(false);
    expect(await check('')).toBe(false);
    // Neither read refreshes the session.
    expect(mocks.client.session.update).not.toHaveBeenCalled();
  });
});
