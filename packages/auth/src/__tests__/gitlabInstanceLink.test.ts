/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * POST /gitlab-instance/link ("Connect Gitlab" for a self-managed instance)
 * through the real `auth.handler`: it reads the session from the database,
 * never from the cookie cache (`sensitiveSessionMiddleware`), so a session
 * that is gone from the database cannot connect an account even while its
 * signed `session_data` cookie is still within its lifetime.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const mocks = vi.hoisted(() => {
  const state = { session: null as Record<string, unknown> | null };
  const owner = {
    id: 'owner-1',
    name: 'Owner',
    email: 'owner@example.edu',
    emailVerified: true,
    image: null,
    created_at: new Date(),
    updated_at: new Date(),
    role: null,
  };
  const noop = () => ({
    findFirst: vi.fn(() => Promise.resolve(null)),
    findUnique: vi.fn(() => Promise.resolve(null)),
    findMany: vi.fn(() => Promise.resolve([])),
    create: vi.fn(({ data }: any) => Promise.resolve({ id: 'row-1', ...data })),
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
    findFirst: vi.fn(({ where }: any) => Promise.resolve(where?.id === 'owner-1' ? owner : null)),
  };
  client.session = {
    ...noop(),
    update: vi.fn(({ data }: any) => Promise.resolve({ ...state.session, ...data })),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(state.session && where?.token === state.session.token ? state.session : null)
    ),
  };
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  const oauthClient = vi.fn(async (instanceId: string) => ({
    instanceId,
    host: 'https://gitlab.example.edu',
    clientId: 'gitlab-client',
    clientSecret: 'gitlab-secret',
  }));
  return { state, client, oauthClient };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
    gitlabInstance: { oauthClient: mocks.oauthClient },
  },
}));

const { auth, COOKIE_PREFIX } = await import('../server.ts');

const BASE = 'http://localhost:3000/api/auth';
const TOKEN = 'session-token-1';

const sessionRow = () => ({
  id: 'sess-1',
  token: TOKEN,
  user_id: 'owner-1',
  expires_at: new Date(Date.now() + 86_400_000),
  created_at: new Date(),
  updated_at: new Date(),
  ip_address: null,
  user_agent: null,
  impersonatedBy: null,
});

async function sessionTokenCookie(): Promise<string> {
  const serialized = await serializeSignedCookie(
    `${COOKIE_PREFIX}.session_token`,
    TOKEN,
    process.env.BETTER_AUTH_SECRET!
  );
  return serialized.split(';')[0]!;
}

/** The session_token and a real session_data (cookie cache) for the current row. */
async function cachedSessionCookies(): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE}/get-session`, { headers: { cookie: await sessionTokenCookie() } })
  );
  const cookies = new Map<string, string>();
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(';')[0]!;
    cookies.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  const sessionData = cookies.get(`${COOKIE_PREFIX}.session_data`);
  expect(sessionData, 'session_data cookie was issued').toBeTruthy();
  return `${cookies.get(`${COOKIE_PREFIX}.session_token`) ?? (await sessionTokenCookie())}; ${sessionData}`;
}

const link = (cookie: string) =>
  auth.handler(
    new Request(`${BASE}/gitlab-instance/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: JSON.stringify({ instanceId: 'inst-1', callbackURL: '/settings/connections' }),
    })
  );

beforeEach(() => {
  mocks.state.session = sessionRow();
  mocks.oauthClient.mockClear();
});

describe('connecting a self-managed Gitlab account', () => {
  it('sends a signed-in user on to their Gitlab (control)', async () => {
    const res = await link(await cachedSessionCookies());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; redirect: boolean };
    expect(body.redirect).toBe(true);
    expect(new URL(body.url).host).toBe('gitlab.example.edu');
    expect(mocks.oauthClient).toHaveBeenCalledWith('inst-1');
  });

  it('refuses a session gone from the database, even with a valid cookie cache', async () => {
    const cookie = await cachedSessionCookies();
    // Revoked (signed out elsewhere, or a password reset): the row is gone,
    // the browser still holds a session_data cookie within its lifetime.
    mocks.state.session = null;

    const res = await link(cookie);

    expect(res.status).toBe(401);
    expect(mocks.oauthClient).not.toHaveBeenCalled();
  });
});
