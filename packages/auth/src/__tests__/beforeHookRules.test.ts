/**
 * The paths each `hooks.before` rule runs on (BEFORE_HOOK_RULES in
 * ../server.ts), so a rule can't drop off a path, or start running on one,
 * without a test saying so:
 *
 *   - the rules, by name and in order;
 *   - each rule's declared paths, against the list here;
 *   - every endpoint path this better-auth declares, written out, and each
 *     with exactly the rules that run on it;
 *   - through the real `auth.handler`, the rules the hook actually runs for a
 *     request, so the hook can't stop going by the declared paths.
 *
 * The lists below are written out, not read from server.ts or better-auth,
 * on purpose. A change to a rule's paths, a new rule, or a better-auth
 * upgrade that adds, removes or renames an endpoint must change this file
 * too, and whoever changes it decides which rules the new path needs.
 * Baselined on better-auth 1.7.18 with @better-auth/mcp, oauth-provider,
 * cimd and the jwt plugin.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const mocks = vi.hoisted(() => {
  const client: Record<string, Record<string, unknown>> = {};
  for (const model of ['user', 'session', 'account', 'verification']) {
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
  client.Verification = client.verification;
  client.User = client.user;
  client.Session = client.session;
  client.Account = client.account;
  return { client, sendAuthOtp: vi.fn(async () => {}) };
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
    authEmail: { sendAuthOtp: mocks.sendAuthOtp },
  },
}));

const { auth, BEFORE_HOOK_RULES, beforeHookRuleCovers } = await import('../server.ts');

/**
 * Every rule, in the order the hook runs them, with the paths it must run on:
 * exactly `only`, or every path but `everyPathBut`.
 */
const EXPECTED_RULES: ReadonlyArray<
  { name: string; only: readonly string[] } | { name: string; everyPathBut: readonly string[] }
> = [
  { name: 'register-no-backchannel-logout', only: ['/oauth2/register'] },
  { name: 'register-open', only: ['/oauth2/register'] },
  { name: 'oauth-resource', only: ['/oauth2/authorize', '/oauth2/token'] },
  { name: 'oauth-offline-access', only: ['/oauth2/authorize'] },
  { name: 'view-as-caller-and-target', only: ['/admin/impersonate-user'] },
  { name: 'view-as-no-app-connection', only: ['/admin/impersonate-user'] },
  {
    name: 'account-link-while-viewing-as',
    only: ['/link-social', '/gitlab-instance/link', '/unlink-account'],
  },
  {
    name: 'account-change-while-viewing-as',
    only: [
      '/change-password',
      '/update-user',
      '/revoke-session',
      '/revoke-sessions',
      '/revoke-other-sessions',
    ],
  },
  { name: 'send-code-type', only: ['/email-otp/send-verification-otp'] },
  // The three endpoints that can issue a code. A saved authorization is
  // resumed by oauth-provider dispatching /oauth2/authorize, which runs the
  // hook with that path.
  { name: 'app-connection', only: ['/oauth2/authorize', '/oauth2/consent', '/oauth2/continue'] },
];

/** Every endpoint the router can serve (auth.api less server-only ones), written out. */
const EXPECTED_DECLARED_PATHS = [
  '/account-info',
  '/admin/ban-user',
  '/admin/create-user',
  '/admin/get-user',
  '/admin/has-permission',
  '/admin/impersonate-user',
  '/admin/list-user-sessions',
  '/admin/list-users',
  '/admin/remove-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/set-role',
  '/admin/set-user-password',
  '/admin/stop-impersonating',
  '/admin/unban-user',
  '/admin/update-user',
  '/callback/:id',
  '/change-email',
  '/change-password',
  '/delete-user',
  '/delete-user/callback',
  '/email-otp/change-email',
  '/email-otp/check-verification-otp',
  '/email-otp/request-email-change',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
  '/email-otp/send-verification-otp',
  '/email-otp/verify-email',
  '/error',
  '/forget-password/email-otp',
  '/get-access-token',
  '/get-session',
  '/gitlab-instance/callback',
  '/gitlab-instance/link',
  '/gitlab-instance/setup',
  '/gitlab-instance/sign-in',
  '/jwks',
  '/link-social',
  '/list-accounts',
  '/list-sessions',
  '/oauth2/authorize',
  '/oauth2/client/rotate-keys',
  '/oauth2/client/rotate-secret',
  '/oauth2/consent',
  '/oauth2/continue',
  '/oauth2/create-client',
  '/oauth2/delete-client',
  '/oauth2/delete-consent',
  '/oauth2/end-session',
  '/oauth2/end-session/confirm',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/introspect',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/register',
  '/oauth2/revoke',
  '/oauth2/token',
  '/oauth2/update-client',
  '/oauth2/update-consent',
  '/oauth2/userinfo',
  '/ok',
  '/refresh-token',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/:token',
  '/revoke-other-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-in/email-otp',
  '/sign-in/social',
  '/sign-out',
  '/sign-up/email',
  '/token',
  '/unlink-account',
  '/update-session',
  '/update-user',
  '/verify-email',
  '/verify-password',
];

const expectedRulesFor = (path: string) =>
  EXPECTED_RULES.filter(rule =>
    'only' in rule ? rule.only.includes(path) : !rule.everyPathBut.includes(path)
  ).map(rule => rule.name);

const actualRulesFor = (path: string) =>
  BEFORE_HOOK_RULES.filter(rule => beforeHookRuleCovers(rule, path)).map(rule => rule.name);

const ruleNamed = (name: string) => {
  const rule = BEFORE_HOOK_RULES.find(r => r.name === name);
  if (!rule) throw new Error(`no hooks.before rule named ${name}`);
  return rule;
};

/**
 * Every endpoint this better-auth declares (auth.api), with its first method,
 * less the server-only ones the router never serves. Paths in disabledPaths
 * stay in: the router 404s them, but in-process auth.api calls still run the
 * hook, so its rules must hold there too.
 */
const DECLARED = Object.values(auth.api as Record<string, unknown>)
  .map(
    e =>
      e as {
        path?: unknown;
        options?: {
          method?: unknown;
          metadata?: { SERVER_ONLY?: unknown; allowedMediaTypes?: readonly string[] };
        };
      }
  )
  .filter(e => typeof e?.path === 'string' && !e.options?.metadata?.SERVER_ONLY)
  .map(e => ({
    path: e.path as string,
    method: String([e.options?.method].flat()[0] ?? 'GET'),
    // oauth-provider's endpoints that take form bodies only (token, authorize POST).
    formOnly: Boolean(
      e.options?.metadata?.allowedMediaTypes?.length &&
      !e.options.metadata.allowedMediaTypes.includes('application/json')
    ),
  }));
const DECLARED_PATHS = [...new Set(DECLARED.map(e => e.path))].sort();

describe('the hooks.before rules', () => {
  it('are the expected rules, in the expected order', () => {
    expect(BEFORE_HOOK_RULES.map(rule => rule.name)).toEqual(EXPECTED_RULES.map(r => r.name));
  });

  it.each(EXPECTED_RULES.map(rule => [rule.name, rule] as const))(
    '%s declares exactly the expected paths',
    (name, expected) => {
      const rule = ruleNamed(name);
      if ('only' in expected) {
        expect('only' in rule.paths).toBe(true);
        expect([...(rule.paths as { only: ReadonlySet<string> }).only].sort()).toEqual(
          [...expected.only].sort()
        );
      } else {
        expect('allExcept' in rule.paths).toBe(true);
        expect([...(rule.paths as { allExcept: ReadonlySet<string> }).allExcept].sort()).toEqual(
          [...expected.everyPathBut].sort()
        );
      }
    }
  );

  it.each(EXPECTED_RULES.map(rule => [rule.name, rule] as const))(
    '%s runs on every path it must and on none it must not',
    (name, expected) => {
      const rule = ruleNamed(name);
      const mustCover =
        'only' in expected
          ? expected.only
          : DECLARED_PATHS.filter(path => !expected.everyPathBut.includes(path));
      const mustNotCover =
        'only' in expected
          ? DECLARED_PATHS.filter(path => !expected.only.includes(path))
          : expected.everyPathBut;
      expect(mustCover.length).toBeGreaterThan(0);
      for (const path of mustCover)
        expect([path, beforeHookRuleCovers(rule, path)]).toEqual([path, true]);
      for (const path of mustNotCover) {
        expect([path, beforeHookRuleCovers(rule, path)]).toEqual([path, false]);
      }
    }
  );

  it('lists only paths better-auth declares, so a renamed endpoint fails here', () => {
    const listed = EXPECTED_RULES.flatMap(rule => ('only' in rule ? rule.only : rule.everyPathBut));
    for (const path of listed) expect(DECLARED_PATHS).toContain(path);
  });

  it('knows every endpoint this better-auth declares, and no other', () => {
    expect(DECLARED_PATHS).toEqual([...EXPECTED_DECLARED_PATHS].sort());
  });

  it('gives every declared path exactly its rules, in order', () => {
    expect(DECLARED_PATHS.length).toBeGreaterThan(50);
    const actual = Object.fromEntries(DECLARED_PATHS.map(path => [path, actualRulesFor(path)]));
    const expected = Object.fromEntries(DECLARED_PATHS.map(path => [path, expectedRulesFor(path)]));
    expect(actual).toEqual(expected);
  });

  it('runs no rule on the token-issuing path but the resource rule', () => {
    expect(actualRulesFor('/oauth2/token')).toEqual(['oauth-resource']);
  });

  it('runs the authorize rules in the order their changes build on each other', () => {
    expect(actualRulesFor('/oauth2/authorize')).toEqual([
      'oauth-resource',
      'oauth-offline-access',
      'app-connection',
    ]);
  });
});

describe('the hook, through auth.handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sends one request for `path` through the real handler, with every rule's
   * `run` replaced by a spy that does nothing, and returns the rules the hook
   * ran, in order.
   */
  async function rulesRunFor(path: string): Promise<string[]> {
    const ran: string[] = [];
    for (const rule of BEFORE_HOOK_RULES) {
      vi.spyOn(rule, 'run').mockImplementation(async () => {
        ran.push(rule.name);
      });
    }
    const endpoint = DECLARED.find(e => e.path === path);
    const method = endpoint?.method ?? 'POST';
    const form = endpoint?.formOnly && method !== 'GET';
    await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method,
        headers: {
          origin: 'http://localhost:3000',
          ...(method === 'GET'
            ? {}
            : {
                'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
              }),
        },
        ...(method === 'GET' ? {} : { body: form ? '' : JSON.stringify({}) }),
      })
    );
    return ran;
  }

  /** The router answers a disabled path with 404 before any hook runs. */
  const DISABLED = new Set<string>(auth.options.disabledPaths ?? []);

  // Every path a rule lists, and a few others.
  const PATHS = [
    ...new Set([
      ...EXPECTED_RULES.flatMap(rule => ('only' in rule ? rule.only : rule.everyPathBut)),
      '/oauth2/revoke',
      '/jwks',
      '/admin/stop-impersonating',
      '/get-session',
      '/sign-out',
      '/sign-in/email',
      '/email-otp/request-password-reset',
    ]),
  ];

  it.each(PATHS.map(path => [path]))('runs exactly the expected rules for %s', async path => {
    expect(await rulesRunFor(path)).toEqual(DISABLED.has(path) ? [] : expectedRulesFor(path));
  });

  it('includes a path the router turns off (/oauth2/continue), whose rules hold in-process', () => {
    expect(DISABLED.has('/oauth2/continue')).toBe(true);
    expect(actualRulesFor('/oauth2/continue')).toEqual(['app-connection']);
  });
});
