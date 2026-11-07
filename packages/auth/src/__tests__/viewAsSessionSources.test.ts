/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * The "view as" rules in `hooks.before` read the request's session two ways:
 * from the `session_data` cookie cache and from the database row the
 * `session_token` cookie names. They are separate cookies and need not
 * describe the same session, and endpoints differ in which one they read
 * (several take `?disableCookieCache` from the query). Each rule refuses when
 * either read is viewing as someone.
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
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1';

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
  // A registered MCP client, so a resumed authorization would look it up.
  client.oauthApplication = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        where?.clientId === 'test-client'
          ? {
              id: 'app-1',
              name: 'Test client',
              icon: null,
              metadata: null,
              clientId: 'test-client',
              clientSecret: null,
              redirectUrls: 'http://localhost:9999/callback',
              type: 'public',
              disabled: false,
              userId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null
      )
    ),
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

const savedAuthorization = () =>
  signed(
    'oidc_login_prompt',
    JSON.stringify({
      client_id: 'test-client',
      response_type: 'code',
      redirect_uri: 'http://localhost:9999/callback',
      scope: 'openid read',
      state: 'client-state',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      prompt: 'consent',
    })
  );

beforeEach(() => {
  mocks.state.sessions = [];
  mocks.state.created = [];
  vi.clearAllMocks();
});

const VIEWING_JARS = ['viewingAs', 'tokenMixed', 'cacheMixed'] as const;

describe('the two session reads', () => {
  it('can describe different sessions for one cookie header', async () => {
    const j = await jars();
    const read = async (cookie: string, disableCookieCache: boolean) =>
      (
        await auth.api.getSession({
          headers: new Headers({ cookie }),
          query: { disableRefresh: true, disableCookieCache },
        })
      )?.user.id;

    expect([await read(j.tokenMixed, false), await read(j.tokenMixed, true)]).toEqual([
      'admin-1',
      'student-1',
    ]);
    expect([await read(j.cacheMixed, false), await read(j.cacheMixed, true)]).toEqual([
      'student-1',
      'admin-1',
    ]);
  });
});

describe('linking or unlinking a sign-in account', () => {
  const LINK_PATHS: Array<[string, Record<string, unknown>]> = [
    ['/link-social?disableCookieCache=true', { provider: 'github', callbackURL: '/settings' }],
    ['/link-social', { provider: 'github', callbackURL: '/settings' }],
    ['/unlink-account?disableCookieCache=true', { providerId: 'github' }],
    ['/unlink-account', { providerId: 'github' }],
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

  it('lets the own jar reach the unlink endpoint, and adds no session cookie of its own', async () => {
    const j = await jars();

    const res = await post('/unlink-account?disableCookieCache=true', j.own, {
      providerId: 'github',
    });

    // The endpoint lists the user's accounts before unlinking one.
    expect(mocks.client.account.findMany).toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
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
        consent_code: 'any-consent-code',
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'access_denied',
        error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
      });
      expect(mocks.client.oauthConsent.create).not.toHaveBeenCalled();
    });
  }

  it('lets the own jar through to the consent endpoint', async () => {
    const j = await jars();

    const res = await post('/oauth2/consent?disableCookieCache=true', j.own, {
      accept: true,
      consent_code: 'unknown-consent-code',
    });

    expect(await res.text()).not.toContain(CONNECT_APP_VIEWING_AS_MESSAGE);
  });

  // The mcp plugin's after-hook resumes a saved authorization on any response
  // that sets a session cookie. The session_token cookie is set again when
  // /get-session refreshes a database-read session that is due for it.
  it('resumes a saved authorization for an ordinary session that is refreshed (control)', async () => {
    addSession('token-due', 'admin-1', null, 2 * 86_400_000);
    const cookie = `${await tokenCookie('token-due')}; ${await savedAuthorization()}`;

    const res = await auth.handler(
      new Request(`${BASE}/get-session?disableCookieCache=true`, { headers: { cookie } })
    );

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, 'http://x').pathname).toBe('/oauth/consent');
    expect(mocks.client.oauthApplication.findFirst).toHaveBeenCalled();
  });

  it('does not resume it for the token-mixed jar when the database read refreshes the session', async () => {
    const j = await jars();
    const cookie = `${j.tokenMixed}; ${await savedAuthorization()}`;

    const res = await auth.handler(
      new Request(`${BASE}/get-session?disableCookieCache=true`, { headers: { cookie } })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mocks.client.oauthApplication.findFirst).not.toHaveBeenCalled();
    expect(mocks.client.verification.create).not.toHaveBeenCalled();
    // The session cookie was set again, so the after-hook's trigger was met.
    expect(res.headers.get('set-cookie') ?? '').toContain(`${COOKIE_PREFIX}.session_token=`);
  });

  it('does not resume it for the cache-mixed jar on a profile update', async () => {
    const j = await jars();
    const cookie = `${j.cacheMixed}; ${await savedAuthorization()}`;

    const res = await post('/update-user', cookie, { name: 'Renamed' });

    expect(res.status).toBe(403);
    expect(mocks.client.oauthApplication.findFirst).not.toHaveBeenCalled();
    expect(mocks.client.verification.create).not.toHaveBeenCalled();
  });
});

describe('starting to view as someone', () => {
  it('is refused for a caller whose two reads are not both a platform admin not viewing as anyone', async () => {
    const j = await jars();

    for (const cookie of [j.viewingAs, j.tokenMixed, j.cacheMixed]) {
      const res = await post('/admin/impersonate-user', cookie, { userId: 'student-1' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: VIEW_AS_PLATFORM_ADMINS_ONLY_MESSAGE });
    }
    expect(mocks.state.created).toHaveLength(0);
  });

  it('works for the own jar', async () => {
    const j = await jars();

    const res = await post('/admin/impersonate-user', j.own, { userId: 'student-1' });

    expect(res.status).toBe(200);
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ user_id: 'student-1', impersonatedBy: 'admin-1' }),
    ]);
  });
});

describe('isViewingAsAnotherUser', () => {
  it('is true for every viewing-as jar and false for the own jar and no session', async () => {
    const j = await jars();
    const check = (cookie: string) => isViewingAsAnotherUser(new Headers({ cookie }));

    expect(await check(j.viewingAs)).toBe(true);
    expect(await check(j.tokenMixed)).toBe(true);
    expect(await check(j.cacheMixed)).toBe(true);
    expect(await check(j.own)).toBe(false);
    expect(await check('')).toBe(false);
    // Neither read refreshes the session.
    expect(mocks.client.session.update).not.toHaveBeenCalled();
  });
});
