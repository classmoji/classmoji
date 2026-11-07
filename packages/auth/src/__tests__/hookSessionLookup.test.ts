/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * The session lookup `hooks.before` makes (`lookupSessionForHook` in
 * server.ts) on POST requests: approving the consent page (POST
 * /oauth2/consent) and starting to view as someone (POST
 * /admin/impersonate-user).
 *
 * From better-auth 1.5 the get-session endpoint refuses POST with
 * METHOD_NOT_ALLOWED unless `session.deferSessionRefresh` is set, and a
 * hook's context carries the request's own method. 1.4.18 ignores the
 * method, so the endpoint is wrapped here to apply the later rule: the
 * lookup must ask as a GET, or approving consent fails with the guard's 503
 * and "view as" with a 405.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
process.env.PLATFORM_ADMIN_USER_IDS = 'admin-1';

// TODO(better-auth 1.7 bump): this wrapper models the later releases' POST
// refusal through the endpoint context's `method`. In the bump PR, confirm it
// against the real 1.7 `api/routes/session.mjs` (and that the hook context
// still carries the request's method), then drop the wrapper if the real
// endpoint already refuses POST here.
const lookups = vi.hoisted(() => ({ methods: [] as unknown[] }));

vi.mock('better-auth/api', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth/api')>();
  return {
    ...actual,
    getSession: (...args: unknown[]) => {
      const endpoint = (actual.getSession as (...a: unknown[]) => any)(...args);
      const asLaterReleases = async (context: { method?: unknown }) => {
        lookups.methods.push(context?.method);
        if (context?.method === 'POST') throw new actual.APIError('METHOD_NOT_ALLOWED');
        return endpoint(context);
      };
      return Object.assign(asLaterReleases, endpoint);
    },
  };
});

const mocks = vi.hoisted(() => {
  const state = { sessions: [] as Record<string, any>[], created: [] as Record<string, any>[] };
  const user = (id: string) => ({
    id,
    name: id,
    email: `${id}@example.edu`,
    emailVerified: true,
    image: null,
    created_at: new Date(),
    updated_at: new Date(),
    role: null,
  });
  const users: Record<string, Record<string, unknown>> = {
    'admin-1': user('admin-1'),
    'owner-1': user('owner-1'),
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
    'oauthConsent',
    'platformAuditLog',
  ]) {
    client[model] = noop();
  }
  client.user = {
    ...noop(),
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
      return Promise.resolve(row);
    }),
  };
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

function signIn(userId: string, impersonatedBy: string | null = null): string {
  const token = `token-${userId}-${impersonatedBy ?? 'self'}`;
  mocks.state.sessions.push({
    id: `sess-${token}`,
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + 86_400_000),
    created_at: new Date(),
    updated_at: new Date(),
    ip_address: null,
    user_agent: null,
    impersonatedBy,
  });
  return token;
}

async function post(path: string, token: string, body: unknown) {
  const cookie = (
    await serializeSignedCookie(
      `${COOKIE_PREFIX}.session_token`,
      token,
      process.env.BETTER_AUTH_SECRET!
    )
  ).split(';')[0]!;
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
  lookups.methods = [];
});

describe('the hook session lookup on a POST request', () => {
  it('refuses approving consent while viewing as someone with access_denied, not a 503', async () => {
    const token = signIn('owner-1', 'admin-1');

    const res = await post('/oauth2/consent', token, { accept: true, consent_code: 'any' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      error_description: CONNECT_APP_VIEWING_AS_MESSAGE,
    });
    // Two lookups, one from the cookie cache and one from the database.
    expect(lookups.methods).toEqual(['GET', 'GET']);
  });

  it('lets approving consent through to the endpoint for an ordinary session', async () => {
    const token = signIn('owner-1');

    const res = await post('/oauth2/consent', token, { accept: true, consent_code: 'unknown' });

    // The endpoint's own answer for a consent code it does not know.
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(405);
    expect(lookups.methods[0]).toBe('GET');
  });

  it('starts viewing as an ordinary user', async () => {
    const token = signIn('admin-1');

    const res = await post('/admin/impersonate-user', token, { userId: 'owner-1' });

    expect(res.status).toBe(200);
    expect(mocks.state.created).toEqual([
      expect.objectContaining({ user_id: 'owner-1', impersonatedBy: 'admin-1' }),
    ]);
    expect(lookups.methods[0]).toBe('GET');
  });
});
