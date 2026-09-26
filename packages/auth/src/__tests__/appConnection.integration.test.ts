/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * Connecting an app (MCP OAuth) through the REAL exported `auth` — real
 * better-auth router, real mcp plugin, real shared `hooks.before` — over
 * `auth.handler`, the entry point both apps/webapp and apps/admin mount at
 * `/api/auth/*`. Only Prisma and the service layer are stood in.
 *
 * Pins, for an ordinary session:
 *   - /mcp/authorize always goes to the consent page, even when the client did
 *     not ask for it, carrying what the page needs (consent_code, client_id,
 *     scope);
 *   - approving on /oauth2/consent returns the client's redirect with a code
 *     and the client's state.
 * And while viewing as another user:
 *   - /mcp/authorize and an approving /oauth2/consent are refused with a
 *     readable message, and no code is stored;
 *   - a denial still goes through.
 * And for an authorization saved while signed out (the `oidc_login_prompt`
 * cookie), which the mcp plugin's after-hook resumes on any response that sets
 * a session cookie:
 *   - it is saved with the consent page required;
 *   - it is not resumed on a request made while viewing as another user.
 * And, for sessions read from the cookie cache (`session_data`), the same
 * refusals; and starting to view as a user (/admin/impersonate-user) with a
 * saved authorization cookie creates the session without resuming it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
// Read once at import: the platform admin who can start viewing as a user.
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1';

const CLIENT_ID = 'test-client';
const REDIRECT = 'http://localhost:9999/callback';

const mocks = vi.hoisted(() => {
  const state = {
    session: null as Record<string, unknown> | null,
    adminSession: null as Record<string, unknown> | null,
    createdSessions: [] as Record<string, any>[],
    admin: {
      id: 'admin-1',
      name: 'Platform admin',
      provider_email: 'admin@example.edu',
      emailVerified: true,
      image: null,
      created_at: new Date(),
      updated_at: new Date(),
      login: 'platform-admin',
      role: null,
    } as Record<string, unknown>,
    user: {
      id: 'owner-1',
      name: 'Owner',
      provider_email: 'owner@example.edu',
      emailVerified: true,
      image: null,
      created_at: new Date(),
      updated_at: new Date(),
      login: 'owner',
      role: null,
    } as Record<string, unknown>,
    verifications: [] as Record<string, any>[],
    consents: [] as Record<string, any>[],
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
  for (const model of ['account', 'oauthAccessToken']) client[model] = noop();
  client.user = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        where?.id === 'owner-1' ? state.user : where?.id === 'admin-1' ? state.admin : null
      )
    ),
  };
  client.session = {
    ...noop(),
    update: vi.fn(({ data }: any) => Promise.resolve({ ...state.session, ...data })),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        [state.session, state.adminSession].find(row => row && where?.token === row.token) ?? null
      )
    ),
    create: vi.fn(({ data }: any) => {
      const row = { id: `sess-new-${state.createdSessions.length}`, ...data };
      state.createdSessions.push(row);
      return Promise.resolve(row);
    }),
  };
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
  client.verification = {
    ...noop(),
    create: vi.fn(({ data }: any) => {
      const row = { id: `ver-${state.verifications.length}`, ...data };
      state.verifications.push(row);
      return Promise.resolve(row);
    }),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(
        state.verifications.find(v => !where?.identifier || v.identifier === where.identifier) ??
          null
      )
    ),
    findMany: vi.fn(({ where }: any) =>
      Promise.resolve(
        state.verifications.filter(v => !where?.identifier || v.identifier === where.identifier)
      )
    ),
    update: vi.fn(({ where, data }: any) => {
      const row = state.verifications.find(v => v.id === where?.id);
      if (row) Object.assign(row, data);
      return Promise.resolve(row ?? data);
    }),
  };
  client.oauthConsent = {
    ...noop(),
    create: vi.fn(({ data }: any) => {
      state.consents.push(data);
      return Promise.resolve(data);
    }),
  };
  // Models configured with a modelName ('Session', 'User', ...) are looked up
  // on the client under that name.
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  return { state, client };
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

const { auth, COOKIE_PREFIX, CONNECT_APP_VIEWING_AS_MESSAGE } = await import('../server.ts');

const BASE = 'http://localhost:3000/api/auth';
const SESSION_TOKEN = 'session-token-1';

const sessionRow = (impersonatedBy: string | null) => ({
  id: 'sess-1',
  token: SESSION_TOKEN,
  user_id: 'owner-1',
  expires_at: new Date(Date.now() + 86_400_000),
  created_at: new Date(),
  updated_at: new Date(),
  ip_address: null,
  user_agent: null,
  impersonatedBy,
});

async function sessionCookie(token = SESSION_TOKEN): Promise<string> {
  const serialized = await serializeSignedCookie(
    `${COOKIE_PREFIX}.session_token`,
    token,
    process.env.BETTER_AUTH_SECRET!
  );
  return serialized.split(';')[0]!;
}

async function authorize(query: Record<string, string> = {}, cookie?: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: 'openid read',
    state: 'client-state',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    ...query,
  });
  return auth.handler(
    new Request(`${BASE}/mcp/authorize?${params}`, {
      headers: { cookie: cookie ?? (await sessionCookie()) },
    })
  );
}

async function consent(accept: boolean, consentCode: string, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}/oauth2/consent`, {
      method: 'POST',
      headers: {
        cookie: cookie ?? (await sessionCookie()),
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ accept, consent_code: consentCode }),
    })
  );
}

beforeEach(() => {
  mocks.state.session = null;
  mocks.state.adminSession = null;
  mocks.state.createdSessions.length = 0;
  mocks.state.verifications.length = 0;
  mocks.state.consents.length = 0;
});

describe('connecting an app with an ordinary session', () => {
  beforeEach(() => {
    mocks.state.session = sessionRow(null);
  });

  it('goes to the consent page even when the client did not ask for it', async () => {
    const res = await authorize();

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!, 'http://localhost:3000');
    expect(location.pathname).toBe('/oauth/consent');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('scope')).toBe('openid read');
    const consentCode = location.searchParams.get('consent_code');
    expect(consentCode).toBeTruthy();
    // The stored request waits for consent and keeps the client's state.
    const stored = JSON.parse(mocks.state.verifications[0]!.value);
    expect(stored).toMatchObject({ requireConsent: true, state: 'client-state' });
    // Nothing went to the client yet.
    expect(res.headers.get('location')).not.toContain(REDIRECT);
  });

  it('goes to the consent page when the client asked for no prompt', async () => {
    const res = await authorize({ prompt: 'none' });
    expect(new URL(res.headers.get('location')!, 'http://x').pathname).toBe('/oauth/consent');
  });

  it('approving returns the client redirect with a code and the client state', async () => {
    const authorized = await authorize();
    const consentCode = new URL(authorized.headers.get('location')!, 'http://x').searchParams.get(
      'consent_code'
    )!;

    const res = await consent(true, consentCode);

    expect(res.status).toBe(200);
    const { redirectURI } = (await res.json()) as { redirectURI: string };
    const target = new URL(redirectURI);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('code')).toBeTruthy();
    expect(target.searchParams.get('state')).toBe('client-state');
    expect(mocks.state.consents).toHaveLength(1);
  });
});

describe('connecting an app while viewing as another user', () => {
  beforeEach(() => {
    mocks.state.session = sessionRow('platform-admin-1');
  });

  it('refuses authorization and stores no code', async () => {
    const res = await authorize();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('refuses approving consent with the message the consent page shows', async () => {
    // A consent request saved before viewing as someone started.
    mocks.state.session = sessionRow(null);
    const authorized = await authorize();
    const consentCode = new URL(authorized.headers.get('location')!, 'http://x').searchParams.get(
      'consent_code'
    )!;
    mocks.state.session = sessionRow('platform-admin-1');

    const res = await consent(true, consentCode);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.consents).toHaveLength(0);
  });

  it('lets a denial through', async () => {
    mocks.state.session = sessionRow(null);
    const authorized = await authorize();
    const consentCode = new URL(authorized.headers.get('location')!, 'http://x').searchParams.get(
      'consent_code'
    )!;
    mocks.state.session = sessionRow('platform-admin-1');

    const res = await consent(false, consentCode);

    expect(res.status).toBe(200);
    const { redirectURI } = (await res.json()) as { redirectURI: string };
    expect(redirectURI).toContain('error=access_denied');
    expect(mocks.state.consents).toHaveLength(0);
  });
});

describe('an authorization saved while signed out', () => {
  const savedQuery = {
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: 'openid read',
    state: 'client-state',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    prompt: 'consent',
  };

  async function loginPromptCookie(query: Record<string, string>) {
    const serialized = await serializeSignedCookie(
      'oidc_login_prompt',
      JSON.stringify(query),
      process.env.BETTER_AUTH_SECRET!
    );
    return serialized.split(';')[0]!;
  }

  /** A session old enough that /get-session refreshes it and sets a new session cookie. */
  const dueForRefresh = (impersonatedBy: string | null) => ({
    ...sessionRow(impersonatedBy),
    expires_at: new Date(Date.now() + 7 * 86_400_000 - 2 * 3_600_000),
  });

  const getSessionWithSavedAuthorization = async () =>
    auth.handler(
      new Request(`${BASE}/get-session`, {
        headers: {
          cookie: `${await sessionCookie()}; ${await loginPromptCookie(savedQuery)}`,
        },
      })
    );

  it('is saved with the consent page required, even when the client did not ask', async () => {
    const params = new URLSearchParams({ ...savedQuery, prompt: '' });
    params.delete('prompt');
    const res = await auth.handler(new Request(`${BASE}/mcp/authorize?${params}`));

    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const saved = decodeURIComponent(/oidc_login_prompt=([^;]+)/.exec(setCookie)![1]!);
    const json = saved.slice(0, saved.lastIndexOf('.'));
    expect(JSON.parse(json)).toMatchObject({ prompt: 'consent', client_id: CLIENT_ID });
  });

  it('is resumed for an ordinary session when a session cookie is set (control)', async () => {
    mocks.state.session = dueForRefresh(null);

    const res = await getSessionWithSavedAuthorization();

    // The after-hook picked the saved authorization up and sent the browser on.
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, 'http://x').pathname).toBe('/oauth/consent');
  });

  it('is not resumed while viewing as another user', async () => {
    mocks.state.session = dueForRefresh('platform-admin-1');

    const res = await getSessionWithSavedAuthorization();

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mocks.state.verifications).toHaveLength(0);
    // The session cookie was still refreshed, so the after-hook's trigger was met.
    expect(res.headers.get('set-cookie') ?? '').toContain(`${COOKIE_PREFIX}.session_token=`);
  });
});

// That apps/webapp and apps/admin both hand /api/auth/* to this one `auth`
// instance is tested by importing both route modules:
// apps/webapp/app/routes/__tests__/appConnectionImpersonation.test.ts.

/** The first segment (`name=value`) of each Set-Cookie, keyed by cookie name. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(';')[0]!;
    out.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  return out;
}

describe('a session presented through the cookie cache (session_data)', () => {
  // Browsers send the signed session_data cookie alongside session_token
  // (cookieCache is on, 24h), and getSession then answers from it without the
  // database. Mint a real one through /get-session, then take the database
  // row away so the cookie is the only place the session can come from.
  async function cachedViewingAsCookies(): Promise<string> {
    mocks.state.session = sessionRow('platform-admin-1');
    const res = await auth.handler(
      new Request(`${BASE}/get-session`, { headers: { cookie: await sessionCookie() } })
    );
    const cookies = setCookies(res);
    const sessionData = cookies.get(`${COOKIE_PREFIX}.session_data`);
    const sessionToken = cookies.get(`${COOKIE_PREFIX}.session_token`) ?? (await sessionCookie());
    expect(sessionData, 'session_data cookie was issued').toBeTruthy();
    mocks.state.session = null;
    return `${sessionToken}; ${sessionData}`;
  }

  it('refuses authorization', async () => {
    const cookie = await cachedViewingAsCookies();

    const res = await authorize({}, cookie);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('refuses authorization even when the client asks to skip the cookie cache', async () => {
    const cookie = await cachedViewingAsCookies();

    const res = await authorize({ disableCookieCache: 'true' }, cookie);

    expect(res.status).toBe(403);
    expect(mocks.state.verifications).toHaveLength(0);
  });

  it('refuses approving consent', async () => {
    const cookie = await cachedViewingAsCookies();

    const res = await consent(true, 'any-consent-code', cookie);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    expect(mocks.state.consents).toHaveLength(0);
  });
});

describe('starting to view as a user with a saved authorization cookie', () => {
  const ADMIN_TOKEN = 'admin-session-token';

  it('creates the viewing-as session and does not resume the saved authorization', async () => {
    mocks.state.adminSession = {
      ...sessionRow(null),
      id: 'sess-admin',
      token: ADMIN_TOKEN,
      user_id: 'admin-1',
    };
    const savedAuthorization = await serializeSignedCookie(
      'oidc_login_prompt',
      JSON.stringify({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT,
        scope: 'openid read',
        state: 'client-state',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        prompt: 'consent',
      }),
      process.env.BETTER_AUTH_SECRET!
    );

    const res = await auth.handler(
      new Request(`${BASE}/admin/impersonate-user`, {
        method: 'POST',
        headers: {
          cookie: `${await sessionCookie(ADMIN_TOKEN)}; ${savedAuthorization.split(';')[0]}`,
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ userId: 'owner-1' }),
      })
    );

    expect(res.status).toBe(200);
    // The viewing-as session was created and its cookie set.
    expect(mocks.state.createdSessions).toHaveLength(1);
    expect(mocks.state.createdSessions[0]).toMatchObject({
      user_id: 'owner-1',
      impersonatedBy: 'admin-1',
    });
    const newToken = mocks.state.createdSessions[0]!.token as string;
    expect(setCookies(res).get(`${COOKIE_PREFIX}.session_token`)).toContain(
      encodeURIComponent(newToken).slice(0, 8)
    );
    // No resume: no redirect to the consent page or the client, no code stored.
    expect(res.headers.get('location')).toBeNull();
    expect(mocks.state.verifications).toHaveLength(0);
  });
});
