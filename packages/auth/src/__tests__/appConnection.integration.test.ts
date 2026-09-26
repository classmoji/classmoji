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
 * And that both mounted handlers (webapp and admin) are this one instance.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const CLIENT_ID = 'test-client';
const REDIRECT = 'http://localhost:9999/callback';

const mocks = vi.hoisted(() => {
  const state = {
    session: null as Record<string, unknown> | null,
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
      Promise.resolve(state.session && where?.id === 'owner-1' ? state.user : null)
    ),
  };
  client.session = {
    ...noop(),
    update: vi.fn(({ data }: any) => Promise.resolve({ ...state.session, ...data })),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(state.session && where?.token === state.session.token ? state.session : null)
    ),
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

async function sessionCookie(): Promise<string> {
  const serialized = await serializeSignedCookie(
    `${COOKIE_PREFIX}.session_token`,
    SESSION_TOKEN,
    process.env.BETTER_AUTH_SECRET!
  );
  return serialized.split(';')[0]!;
}

async function authorize(query: Record<string, string> = {}) {
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
      headers: { cookie: await sessionCookie() },
    })
  );
}

async function consent(accept: boolean, consentCode: string) {
  return auth.handler(
    new Request(`${BASE}/oauth2/consent`, {
      method: 'POST',
      headers: {
        cookie: await sessionCookie(),
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ accept, consent_code: consentCode }),
    })
  );
}

beforeEach(() => {
  mocks.state.session = null;
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

describe('both apps mount this one instance', () => {
  it('apps/webapp and apps/admin hand /api/auth/* to the shared auth.handler', async () => {
    const { readFile } = await import('node:fs/promises');
    const root = new URL('../../../../', import.meta.url);
    for (const route of [
      'apps/webapp/app/routes/api.auth.$.ts',
      'apps/admin/app/routes/api.auth.$.ts',
    ]) {
      const source = await readFile(new URL(route, root), 'utf8');
      expect(source, route).toMatch(/import \{ auth \} from '@classmoji\/auth\/server'/);
      expect(source, route).toMatch(/return auth\.handler\(request\)/);
    }
  });
});
