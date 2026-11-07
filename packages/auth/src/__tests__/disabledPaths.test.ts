/**
 * Paths better-auth's HTTP router answers 404 for (`disabledPaths` in
 * server.ts), through the same `auth.handler` every app mounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSignedCookie } from 'better-call';
import { hashPassword } from 'better-auth/crypto';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const mocks = vi.hoisted(() => {
  const client: Record<string, Record<string, unknown>> = {};
  for (const model of [
    'user',
    'session',
    'account',
    'verification',
    'oauthAccessToken',
    'oauthApplication',
    'oauthConsent',
  ]) {
    client[model] = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: { data: unknown }) => Promise.resolve(data)),
      update: vi.fn(({ data }: { data: unknown }) => Promise.resolve(data)),
      delete: vi.fn(() => Promise.resolve({})),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      count: vi.fn(() => Promise.resolve(0)),
    };
  }
  // better-auth looks some models up by their schema name.
  client.Verification = client.verification;
  client.User = client.user;
  client.Session = client.session;
  client.Account = client.account;
  const sendAuthOtp = vi.fn(async () => {});
  return { client, sendAuthOtp };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
    authEmail: { sendAuthOtp: mocks.sendAuthOtp },
  },
}));

const { auth, ADMIN_PATHS_NOT_USED, COOKIE_PREFIX, UNSUPPORTED_CODE_TYPE_MESSAGE } = await import(
  '../server.ts'
);

const BASE = 'http://localhost:3000/api/auth';

describe('disabled better-auth paths', () => {
  it('answers /list-sessions with 404', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/list-sessions`, { headers: { cookie: 'classmoji.session_token=x' } })
    );
    expect(res.status).toBe(404);
  });

  it.each([['/get-access-token'], ['/refresh-token']])('answers POST %s with 404', async path => {
    const res = await auth.handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'classmoji.session_token=x' },
        body: JSON.stringify({ providerId: 'github' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it.each([['/sign-in/email-otp'], ['/email-otp/check-verification-otp']])(
    'answers POST %s with 404',
    async path => {
      const res = await auth.handler(
        new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'someone@example.com', otp: '123456', type: 'sign-in' }),
        })
      );
      expect(res.status).toBe(404);
    }
  );

  // The flows the sign-in page does use stay up: verifying an address,
  // requesting a reset code and resetting a password with it. The deprecated
  // /forget-password/email-otp stays up too, for pages loaded before the
  // sign-in page moved to /email-otp/request-password-reset.
  it.each([
    ['/email-otp/verify-email'],
    ['/email-otp/reset-password'],
    ['/email-otp/request-password-reset'],
    ['/forget-password/email-otp'],
  ])('still routes POST %s', async path => {
    const res = await auth.handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com', otp: '123456', password: 'x' }),
      })
    );
    expect(res.status).not.toBe(404);
  });

  it('leaves the in-process auth.api.getAccessToken and refreshToken in place', async () => {
    // Router-only: the endpoint still runs in-process and answers as it would
    // without a session, not with the router's 404.
    expect(typeof auth.api.getAccessToken).toBe('function');
    expect(typeof auth.api.refreshToken).toBe('function');
    const error = await auth.api
      .getAccessToken({ body: { providerId: 'github' }, headers: new Headers() })
      .then(
        () => null,
        (e: unknown) => e
      );
    // No session in this call: the endpoint's own 401, not the router's 404.
    expect(error).toMatchObject({ statusCode: 401 });
  });

  it('still serves /get-session', async () => {
    const res = await auth.handler(new Request(`${BASE}/get-session`));
    expect(res.status).toBe(200);
  });
});

describe('/verify-password', () => {
  const PASSWORD = 'correct-horse-battery-1';
  const replaced = [
    [mocks.client.session!, 'findFirst'],
    [mocks.client.user!, 'findFirst'],
    [mocks.client.account!, 'findMany'],
  ] as const;
  const originals = replaced.map(([model, key]) => model[key]);
  afterEach(() => {
    replaced.forEach(([model, key], i) => (model[key] = originals[i]));
  });

  /** A signed-in password user, as Prisma returns the rows better-auth reads. */
  async function passwordUser(): Promise<Headers> {
    const now = new Date();
    mocks.client.session!.findFirst = vi.fn(() =>
      Promise.resolve({
        id: 'sess-1',
        token: 'token-1',
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000),
        created_at: now,
        updated_at: now,
        impersonatedBy: null,
      })
    );
    mocks.client.user!.findFirst = vi.fn(() =>
      Promise.resolve({
        id: 'user-1',
        name: 'User',
        email: 'user@example.edu',
        emailVerified: true,
        created_at: now,
        updated_at: now,
      })
    );
    mocks.client.account!.findMany = vi.fn(async () => [
      {
        id: 'acct-1',
        user_id: 'user-1',
        account_id: 'user-1',
        provider_id: 'credential',
        password: await hashPassword(PASSWORD),
        created_at: now,
        updated_at: now,
      },
    ]);
    const cookie = (
      await serializeSignedCookie(
        `${COOKIE_PREFIX}.session_token`,
        'token-1',
        process.env.BETTER_AUTH_SECRET!
      )
    ).split(';')[0]!;
    return new Headers({ cookie });
  }

  it('answers POST /verify-password with 404', async () => {
    const headers = await passwordUser();
    headers.set('content-type', 'application/json');
    const res = await auth.handler(
      new Request(`${BASE}/verify-password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('still verifies a password in-process (auth.api.verifyPassword)', async () => {
    const headers = await passwordUser();

    await expect(
      auth.api.verifyPassword({ body: { password: PASSWORD }, headers })
    ).resolves.toEqual({ status: true });
    await expect(
      auth.api.verifyPassword({ body: { password: 'not-the-password' }, headers })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("the admin plugin's endpoints", () => {
  /** Every admin-plugin endpoint this better-auth version serves, with its method. */
  const adminEndpoints = Object.values(auth.api as Record<string, unknown>)
    .map(e => e as { path?: unknown; options?: { method?: unknown } })
    .filter(e => typeof e?.path === 'string' && e.path.startsWith('/admin/'))
    .map(e => ({ path: e.path as string, method: String(e.options?.method) }));
  const KEPT = ['/admin/impersonate-user', '/admin/stop-impersonating'];

  it('turns off every one but View as start and stop', () => {
    expect(adminEndpoints.length).toBeGreaterThan(KEPT.length);
    expect([...ADMIN_PATHS_NOT_USED, ...KEPT].sort()).toEqual(
      adminEndpoints.map(e => e.path).sort()
    );
  });

  it.each(ADMIN_PATHS_NOT_USED.map(path => [path]))('answers %s with 404', async path => {
    const method = adminEndpoints.find(e => e.path === path)?.method ?? 'POST';
    const res = await auth.handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          origin: 'http://localhost:3000',
          cookie: 'classmoji.session_token=x',
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ userId: 'u1', role: 'admin' }) }),
      })
    );
    expect(res.status).toBe(404);
  });

  it.each(KEPT.map(path => [path]))('still routes POST %s', async path => {
    const res = await auth.handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'u1' }),
      })
    );
    // No session: the endpoint's own refusal, not the router's 404.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('leaves the in-process auth.api admin endpoints in place', async () => {
    const error = await auth.api.listUsers({ query: {}, headers: new Headers() }).then(
      () => null,
      (e: unknown) => e
    );
    // No session in this call: the endpoint's own 401, not the router's 404.
    expect(error).toMatchObject({ statusCode: 401 });
  });
});

describe('/email-otp/send-verification-otp', () => {
  const USER = {
    id: 'u1',
    name: 'U',
    email: 'someone@example.com',
    emailVerified: false,
    image: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const send = (type: string) =>
    auth.handler(
      new Request(`${BASE}/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: USER.email, type }),
      })
    );

  beforeEach(() => {
    mocks.sendAuthOtp.mockClear();
    (mocks.client.user.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where?: { email?: string } }) =>
        where?.email === USER.email ? USER : null
    );
  });
  afterEach(() => {
    (mocks.client.user.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async () => null);
  });

  it.each([['forget-password'], ['sign-in'], ['anything-else']])(
    'refuses type %s with a 400 and sends nothing',
    async type => {
      const res = await send(type);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ message: UNSUPPORTED_CODE_TYPE_MESSAGE });
      expect(mocks.sendAuthOtp).not.toHaveBeenCalled();
    }
  );

  it('still sends an email-verification code', async () => {
    const res = await send('email-verification');

    expect(res.status).toBe(200);
    expect(mocks.sendAuthOtp).toHaveBeenCalledWith(
      USER.email,
      expect.any(String),
      'email-verification'
    );
  });
});

describe('reset-code rate limits', () => {
  it('limits both paths that mail a reset code to 3 a minute per client', () => {
    const rules = auth.options.rateLimit?.customRules ?? {};
    expect(rules['/email-otp/request-password-reset']).toEqual({ window: 60, max: 3 });
    expect(rules['/forget-password/email-otp']).toEqual({ window: 60, max: 3 });
  });
});
