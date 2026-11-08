/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * Connecting an app (MCP OAuth) through the REAL exported `auth` — real
 * better-auth 1.7.18 router, real oauth-provider (through @better-auth/mcp),
 * real shared `hooks.before` — over `auth.handler`, the entry point both
 * apps/webapp and apps/admin mount at `/api/auth/*`. Only Prisma and the
 * service layer are stood in. Token issuance, on a real database, is in
 * ./oauth2.integration.test.ts.
 *
 * Pins, for an ordinary session:
 *   - /oauth2/authorize always goes to the consent page, even when the client
 *     asked for no prompt, with the MCP resource and `offline_access` filled
 *     in; by GET and by POST;
 *   - approving on /oauth2/consent returns the client's redirect with a code
 *     and the client's state, not the consent page again (no loop);
 *   - an authorization started while signed out is resumed by the sign-in
 *     that carries its signed query, and reaches the consent page.
 * And while viewing as another user:
 *   - authorize, an approving consent and continue are refused with a
 *     readable message, and no code or consent is stored; a denial goes
 *     through;
 *   - starting to view as someone with a signed query is refused;
 *   - a resumed authorization for a viewing-as session is refused at
 *     /oauth2/authorize even if the start had not been (the session the
 *     re-dispatch carries is read first);
 *   - a viewing-as session presented through the cookie cache is refused too.
 * And client registration is open registration, signed in or not, with no
 * back-channel logout, at /oauth2/register and at the 1.4 path the webapp
 * maps to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { hashPassword } from 'better-auth/crypto';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
// Read once at import: the platform admin who can start viewing as a user.
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1';

const CLIENT_ID = 'test-client';
const REDIRECT = 'http://localhost:9999/callback';
const PASSWORD = 'owner-password-123';

const mocks = vi.hoisted(() => {
  const user = (id: string, email: string) => ({
    id,
    name: id,
    email,
    emailVerified: true,
    image: null,
    created_at: new Date(),
    updated_at: new Date(),
    role: null,
    banned: false,
  });
  const state = {
    users: {
      'owner-1': user('owner-1', 'owner@example.edu'),
      'admin-1': user('admin-1', 'admin@example.edu'),
    } as Record<string, Record<string, unknown>>,
    sessions: [] as Record<string, any>[],
    verifications: [] as Record<string, any>[],
    consents: [] as Record<string, any>[],
    clients: [] as Record<string, any>[],
    passwordHash: '',
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
  for (const model of ['platformAuditLog']) client[model] = noop();
  client.user = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        where?.id
          ? (state.users[where.id] ?? null)
          : (Object.values(state.users).find(u => u.email === where?.email) ?? null)
      )
    ),
    findUnique: vi.fn(({ where }: any) =>
      Promise.resolve(state.users[where?.id] ? { role: null } : null)
    ),
  };
  const credential = (userId: string) => ({
    id: `acct-${userId}`,
    user_id: userId,
    account_id: userId,
    provider_id: 'credential',
    password: state.passwordHash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  client.account = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(where?.user_id ? credential(where.user_id) : null)
    ),
    findMany: vi.fn(({ where }: any) =>
      Promise.resolve(where?.user_id ? [credential(where.user_id)] : [])
    ),
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
      const row = { id: `sess-new-${state.sessions.length}`, ...data };
      state.sessions.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn(({ where, data }: any) => {
      const row = state.sessions.find(s => s.token === where?.token || s.id === where?.id);
      return Promise.resolve({ ...row, ...data });
    }),
  };
  client.verification = {
    ...noop(),
    create: vi.fn(({ data }: any) => {
      const row = { id: `ver-${state.verifications.length}`, ...data };
      state.verifications.push(row);
      return Promise.resolve(row);
    }),
  };
  client.oauthClient = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(state.clients.find(c => c.clientId === where?.clientId) ?? null)
    ),
    create: vi.fn(({ data }: any) => {
      const row = { id: `client-${state.clients.length}`, ...data };
      state.clients.push(row);
      return Promise.resolve(row);
    }),
  };
  client.oauthConsent = {
    ...noop(),
    create: vi.fn(({ data }: any) => {
      const row = { id: `consent-${state.consents.length}`, ...data };
      state.consents.push(row);
      return Promise.resolve(row);
    }),
    // The authorize re-dispatch after consent looks the new row up.
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        state.consents.find(c => c.clientId === where?.clientId && c.userId === where?.userId) ??
          null
      )
    ),
    findMany: vi.fn(({ where }: any) =>
      Promise.resolve(
        state.consents.filter(c => c.clientId === where?.clientId && c.userId === where?.userId)
      )
    ),
  };
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  return { state, client };
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
  auth,
  BEFORE_HOOK_RULES,
  BACKCHANNEL_LOGOUT_REFUSED_MESSAGE,
  COOKIE_PREFIX,
  CONNECT_APP_VIEWING_AS_MESSAGE,
  MCP_RESOURCE,
  VIEW_AS_WHILE_CONNECTING_MESSAGE,
  verifiedAuthorizationQuery,
} = await import('../server.ts');
const { withLegacyMcpPathMapped } = await import('../oauthHttp.ts');

const BASE = 'http://localhost:3000/api/auth';
const SECRET = process.env.BETTER_AUTH_SECRET!;

const signed = async (name: string, value: string) =>
  (await serializeSignedCookie(name, value, SECRET)).split(';')[0]!;

/** A session row for `userId`, and its signed session_token cookie. */
async function signIn(userId: string, impersonatedBy: string | null = null): Promise<string> {
  const token = `token-${userId}-${impersonatedBy ?? 'own'}`;
  mocks.state.sessions.push({
    id: `sess-${token}`,
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + 3_600_000),
    created_at: new Date(),
    updated_at: new Date(),
    ip_address: null,
    user_agent: null,
    impersonatedBy,
  });
  return signed(`${COOKIE_PREFIX}.session_token`, token);
}

const AUTHORIZE_PARAMS = {
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT,
  scope: 'read write',
  state: 'client-state',
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
};

async function authorize(query: Record<string, string> = {}, cookie?: string) {
  const params = new URLSearchParams({ ...AUTHORIZE_PARAMS, ...query });
  return auth.handler(
    new Request(`${BASE}/oauth2/authorize?${params}`, {
      headers: cookie ? { cookie } : {},
    })
  );
}

/** The signed query the consent (or sign-in) page is sent with. */
function signedQueryOf(res: Response): URLSearchParams {
  const location = res.headers.get('location');
  if (!location) throw new Error(`no redirect (status ${res.status})`);
  return new URL(location, 'http://localhost:3000').searchParams;
}

async function post(path: string, cookie: string | null, body: unknown) {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(async () => {
  mocks.state.sessions.length = 0;
  mocks.state.verifications.length = 0;
  mocks.state.consents.length = 0;
  mocks.state.clients.length = 0;
  mocks.state.clients.push({
    id: 'client-row-1',
    clientId: CLIENT_ID,
    name: 'Test client',
    clientSecret: null,
    disabled: false,
    redirectUris: [REDIRECT],
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
    tokenEndpointAuthMethod: 'none',
    applicationType: 'native',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mocks.state.passwordHash ||= await hashPassword(PASSWORD);
  vi.clearAllMocks();
});

describe('connecting an app with an ordinary session', () => {
  it('goes to the consent page even when the client asked for no prompt', async () => {
    const cookie = await signIn('owner-1');
    for (const prompt of [undefined, 'none']) {
      const res = await authorize(prompt ? { prompt } : {}, cookie);

      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!, 'http://x').pathname).toBe('/oauth/consent');
      const query = signedQueryOf(res);
      expect(query.get('prompt')).toBe('consent');
      expect(query.get('client_id')).toBe(CLIENT_ID);
      // The resource and offline_access are filled in before it is signed.
      expect(query.get('resource')).toBe(MCP_RESOURCE);
      expect(query.get('scope')?.split(' ')).toEqual(['read', 'write', 'offline_access']);
      expect(query.get('sig')).toBeTruthy();
    }
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('goes to the consent page for a POST authorize request too', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/oauth2/authorize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://localhost:3000',
          cookie: await signIn('owner-1'),
        },
        body: new URLSearchParams(AUTHORIZE_PARAMS).toString(),
      })
    );

    expect(res.status).toBe(302);
    const query = signedQueryOf(res);
    expect(new URL(res.headers.get('location')!, 'http://x').pathname).toBe('/oauth/consent');
    expect(query.get('prompt')).toBe('consent');
    expect(query.get('resource')).toBe(MCP_RESOURCE);
  });

  it('approving returns the client redirect with a code, not the consent page again', async () => {
    const cookie = await signIn('owner-1');
    const oauthQuery = signedQueryOf(await authorize({}, cookie)).toString();

    const res = await post('/oauth2/consent', cookie, { accept: true, oauth_query: oauthQuery });

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const target = new URL(url);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('code')).toBeTruthy();
    expect(target.searchParams.get('state')).toBe('client-state');
    expect(mocks.state.consents).toEqual([
      expect.objectContaining({
        clientId: CLIENT_ID,
        userId: 'owner-1',
        resources: [MCP_RESOURCE],
        scopes: ['read', 'write', 'offline_access'],
      }),
    ]);
    // One authorization code stored.
    expect(mocks.state.verifications).toHaveLength(1);
  });

  it('resumes an authorization started while signed out, at the consent page', async () => {
    const signedOut = await authorize();
    expect(new URL(signedOut.headers.get('location')!, 'http://x').pathname).toBe('/');
    const oauthQuery = signedQueryOf(signedOut).toString();

    const res = await post('/sign-in/email', null, {
      email: 'owner@example.edu',
      password: PASSWORD,
      oauth_query: oauthQuery,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; redirect?: boolean };
    expect(body.redirect).toBe(true);
    expect(new URL(body.url!, 'http://x').pathname).toBe('/oauth/consent');
    expect(
      signedQueryOf(new Response(null, { headers: { location: body.url! } })).get('prompt')
    ).toBe('consent');
  });
});

describe('the signed query the consent page checks (verifiedAuthorizationQuery)', () => {
  const consentSearch = async () => {
    const res = await authorize({}, await signIn('owner-1'));
    return new URL(res.headers.get('location')!, 'http://localhost:3000').search;
  };

  it('checks out as the provider signed it, without parameters the page added', async () => {
    const search = await consentSearch();

    const signed = await verifiedAuthorizationQuery(`${search}&utm_source=mail`);

    expect(signed?.toString()).toBe(new URLSearchParams(search).toString());
    expect(signed?.has('utm_source')).toBe(false);
    expect(signed?.get('client_id')).toBe(CLIENT_ID);
  });

  it('is what the consent endpoint takes as oauth_query', async () => {
    const cookie = await signIn('owner-1');
    const signed = await verifiedAuthorizationQuery(await consentSearch());

    const res = await post('/oauth2/consent', cookie, { accept: true, oauth_query: `${signed}` });

    expect(res.status).toBe(200);
    expect(
      new URL(((await res.json()) as { url: string }).url).searchParams.get('code')
    ).toBeTruthy();
  });

  it.each([
    ['a changed scope', (q: URLSearchParams) => q.set('scope', 'read write admin')],
    [
      'a changed redirect URI',
      (q: URLSearchParams) => q.set('redirect_uri', 'https://x.example/cb'),
    ],
    ['a removed parameter', (q: URLSearchParams) => q.delete('state')],
    ['no signature', (q: URLSearchParams) => q.delete('sig')],
    ['no list of signed names', (q: URLSearchParams) => q.delete('ba_param')],
    ['a second signature', (q: URLSearchParams) => q.append('sig', q.get('sig')!)],
  ])('refuses one with %s', async (_label, change) => {
    const query = new URLSearchParams(await consentSearch());
    change(query);
    expect(await verifiedAuthorizationQuery(`?${query}`)).toBeNull();
  });

  it('refuses one that has expired', async () => {
    const search = await consentSearch();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60 * 1000 });
    try {
      expect(await verifiedAuthorizationQuery(search)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('connecting an app while viewing as another user', () => {
  it('refuses authorization and stores no code', async () => {
    const res = await authorize({}, await signIn('owner-1', 'admin-1'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('refuses approving consent, with the message the consent page shows', async () => {
    const own = await signIn('owner-1');
    const oauthQuery = signedQueryOf(await authorize({}, own)).toString();

    const res = await post('/oauth2/consent', await signIn('owner-1', 'admin-1'), {
      accept: true,
      oauth_query: oauthQuery,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.consents).toHaveLength(0);
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('lets a denial through', async () => {
    const own = await signIn('owner-1');
    const oauthQuery = signedQueryOf(await authorize({}, own)).toString();

    const res = await post('/oauth2/consent', await signIn('owner-1', 'admin-1'), {
      accept: false,
      oauth_query: oauthQuery,
    });

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).searchParams.get('error')).toBe('access_denied');
    expect(mocks.state.consents).toHaveLength(0);
  });

  it('refuses /oauth2/continue (off over HTTP; in-process)', async () => {
    const own = await signIn('owner-1');
    const oauthQuery = signedQueryOf(await authorize({}, own)).toString();
    const viewing = await signIn('owner-1', 'admin-1');

    const error = await (auth.api as any)
      .oauth2Continue({
        body: { postLogin: true, oauth_query: oauthQuery },
        headers: new Headers({ cookie: viewing }),
      })
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(error).toMatchObject({
      statusCode: 403,
      body: { error: 'access_denied', error_description: CONNECT_APP_VIEWING_AS_MESSAGE },
    });
  });

  it('refuses a viewing-as session read from the cookie cache', async () => {
    const viewing = await signIn('owner-1', 'admin-1');
    const read = await auth.handler(
      new Request(`${BASE}/get-session`, { headers: { cookie: viewing } })
    );
    const cache = read.headers
      .getSetCookie()
      .map(c => c.split(';')[0]!)
      .find(c => c.startsWith(`${COOKIE_PREFIX}.session_data=`));
    expect(cache).toBeTruthy();
    // The row is gone; the cache alone still says "viewing as".
    mocks.state.sessions.length = 0;

    const res = await authorize({}, `${viewing}; ${cache}`);

    expect(res.status).toBe(403);
    expect(mocks.state.verifications).toHaveLength(0);
  });
});

describe('starting to view as someone in the middle of connecting an app', () => {
  it('is refused: no session, no audit row, no code', async () => {
    const oauthQuery = signedQueryOf(await authorize()).toString();

    const res = await post('/admin/impersonate-user', await signIn('admin-1'), {
      userId: 'owner-1',
      oauth_query: oauthQuery,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: VIEW_AS_WHILE_CONNECTING_MESSAGE });
    expect(mocks.state.sessions.filter(s => s.impersonatedBy)).toHaveLength(0);
    expect(mocks.client.platformAuditLog.create).not.toHaveBeenCalled();
    expect(mocks.state.verifications).toHaveLength(0);
    expect(mocks.state.consents).toHaveLength(0);
  });

  it('starts as usual without one (control)', async () => {
    const res = await post('/admin/impersonate-user', await signIn('admin-1'), {
      userId: 'owner-1',
    });
    expect(res.status).toBe(200);
    expect(mocks.state.sessions.filter(s => s.impersonatedBy === 'admin-1')).toHaveLength(1);
  });

  // The resume itself: with the start's own refusal taken away, the
  // provider dispatches /oauth2/authorize for the new viewing-as session
  // while the request's cookies are still the admin's own, and the
  // app-connection rule refuses it from the session the dispatch carries.
  it('would be refused at the resumed /oauth2/authorize even without that rule', async () => {
    const rule = BEFORE_HOOK_RULES.find(r => r.name === 'view-as-no-app-connection')!;
    const spy = vi.spyOn(rule, 'run').mockResolvedValue(undefined);
    try {
      const oauthQuery = signedQueryOf(await authorize()).toString();

      const res = await post('/admin/impersonate-user', await signIn('admin-1'), {
        userId: 'owner-1',
        oauth_query: oauthQuery,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'access_denied',
        error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
      });
      expect(mocks.state.verifications).toHaveLength(0);
      expect(mocks.state.consents).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.each([
  ['/oauth2/register'],
  // The 1.4 path, which the webapp maps to it (../oauthHttp.ts).
  ['/mcp/register'],
])('client registration at %s', path => {
  const register = async (body: Record<string, unknown>, cookie?: string) =>
    auth.handler(
      await withLegacyMcpPathMapped(
        new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({
            client_name: 'Some MCP client',
            redirect_uris: ['http://127.0.0.1:33418/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            ...body,
          }),
        })
      )
    );

  it('registers an open client, signed in or not, owned by no one', async () => {
    for (const cookie of [undefined, await signIn('owner-1')]) {
      mocks.client.oauthClient.create.mockClear();
      const res = await register({}, cookie);
      expect(res.status).toBe(201);
      const [[args]] = mocks.client.oauthClient.create.mock.calls as any[];
      expect(args.data.userId ?? null).toBeNull();
    }
  });

  it.each([
    [{ backchannel_logout_uri: 'https://client.example/logout' }],
    [{ backchannel_logout_session_required: true }],
  ])('refuses back-channel logout (%o)', async fields => {
    const res = await register(fields);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_client_metadata',
      error_description: BACKCHANNEL_LOGOUT_REFUSED_MESSAGE,
    });
    expect(mocks.client.oauthClient.create).not.toHaveBeenCalled();
  });
});
