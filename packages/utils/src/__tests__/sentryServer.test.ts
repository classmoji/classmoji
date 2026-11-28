import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Breadcrumb, ErrorEvent } from '@sentry/core';
import { markReported, reportError, setErrorReporter, type ReportContext } from '../errorReport.ts';
import {
  SENSITIVE_PATHS,
  captureWithContext,
  isOriginRefusal,
  isRenderAbort,
  isSecretKey,
  reportRenderError,
  reportRouteError,
  createSentryReporter,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  sentryOffOptions,
  sentryServerEnvironment,
  sentryServerOptions,
  shouldReportRouteError,
  toReportableError,
  workerIntegrations,
} from '../sentryServer.ts';

const DSN = 'https://public@o0.ingest.sentry.io/0';

/** sentryServerOptions for a case that must be on. */
const mustBeOn = (...args: Parameters<typeof sentryServerOptions>) => {
  const options = sentryServerOptions(...args);
  if (!options) throw new Error('expected Sentry options');
  return options;
};

describe('sentryServerOptions', () => {
  it('is null without a DSN, so Sentry stays off', () => {
    expect(sentryServerOptions({}, { app: 'webapp', runtime: 'server' })).toBeNull();
    expect(
      sentryServerOptions({ SENTRY_DSN: '  ' }, { app: 'webapp', runtime: 'server' })
    ).toBeNull();
  });

  it('carries the DSN, environment, tags and the restrictive data collection', () => {
    const options = mustBeOn(
      { SENTRY_DSN: ` ${DSN} `, FLY_APP_NAME: 'classmoji-mcp-staging' },
      { app: 'mcp', runtime: 'server' }
    );
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe('staging');
    expect(options.initialScope).toEqual({ tags: { app: 'mcp', runtime_kind: 'server' } });
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('tracesSampler');
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    });
    // A fresh object every time: an SDK normalising it in place cannot leak
    // into the next call.
    const again = mustBeOn({ SENTRY_DSN: DSN }, { app: 'mcp', runtime: 'server' });
    expect(again.dataCollection).not.toBe(options.dataCollection);
  });

  it('scrubs in beforeSend and beforeBreadcrumb', () => {
    const options = mustBeOn({ SENTRY_DSN: DSN }, { app: 'webapp', runtime: 'server' });
    const event = options.beforeSend(
      {
        type: undefined,
        request: { url: 'https://a.test/join/abc?x=1', headers: { a: 'b' } },
      } as ErrorEvent,
      {}
    );
    expect(event?.request).toEqual({ url: 'https://a.test/join/[code]' });
    expect(options.beforeBreadcrumb({ category: 'console', message: 'hi' })).toBeNull();
  });

  it('takes an explicit environment over everything', () => {
    const options = mustBeOn(
      { SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'staging', FLY_APP_NAME: 'classmoji-webapp' },
      { app: 'admin', runtime: 'worker', environment: 'dev' }
    );
    expect(options.environment).toBe('dev');
  });
});

describe('sentryServerEnvironment', () => {
  it('prefers SENTRY_ENVIRONMENT (Workers have no Fly app name)', () => {
    expect(sentryServerEnvironment({ SENTRY_ENVIRONMENT: ' staging ' })).toBe('staging');
    expect(
      sentryServerEnvironment({ SENTRY_ENVIRONMENT: 'production', FLY_APP_NAME: 'x-staging' })
    ).toBe('production');
  });

  it('falls back to the Fly app name, then development', () => {
    expect(sentryServerEnvironment({ FLY_APP_NAME: 'classmoji-collab' })).toBe('production');
    expect(sentryServerEnvironment({ SENTRY_ENVIRONMENT: ' ', FLY_APP_NAME: 'x-dev' })).toBe('dev');
    expect(sentryServerEnvironment({})).toBe('development');
  });
});

describe('sentryOffOptions', () => {
  it('has an empty DSN (no fallback to env.SENTRY_DSN) and is disabled', () => {
    expect(sentryOffOptions()).toEqual({ dsn: '', enabled: false });
    expect(sentryOffOptions()).not.toBe(sentryOffOptions());
  });
});

describe('workerIntegrations', () => {
  it('drops Console and retunes Fetch and HttpServer', () => {
    type Fake = { name: string; options: unknown };
    const fetchIntegration = vi.fn((options: { breadcrumbs: false }): Fake => ({
      name: 'Fetch',
      options,
    }));
    const httpServerIntegration = vi.fn(
      (options: { maxRequestBodySize: 'none'; spans: false }): Fake => ({
        name: 'HttpServer',
        options,
      })
    );
    const defaults = [
      'Dedupe',
      'Console',
      'Fetch',
      'HttpServer',
      'RequestData',
      'LinkedErrors',
    ].map((name): Fake => ({ name, options: undefined }));
    const result = workerIntegrations({ fetchIntegration, httpServerIntegration })(defaults);
    expect(result.map(i => i.name)).toEqual([
      'Dedupe',
      'RequestData',
      'LinkedErrors',
      'Fetch',
      'HttpServer',
    ]);
    expect(fetchIntegration).toHaveBeenCalledWith({ breadcrumbs: false });
    expect(httpServerIntegration).toHaveBeenCalledWith({
      maxRequestBodySize: 'none',
      spans: false,
    });
  });
});

describe('scrubUrl', () => {
  it('drops the query string and the fragment', () => {
    expect(scrubUrl('https://classmoji.io/student/cs52?token=abc&x=1#frag')).toBe(
      'https://classmoji.io/student/cs52'
    );
    expect(scrubUrl('/oauth2/authorize?client_id=x&code_challenge=y')).toBe('/oauth2/authorize');
    expect(scrubUrl('/slides/abc/follow?shareCode=SHARE')).toBe('/slides/abc/follow');
    expect(scrubUrl('/forms/x/verify?token=t')).toBe('/forms/x/verify');
  });

  it('drops credentials in the authority', () => {
    expect(scrubUrl('https://x-access-token:ghs_abc123@github.com/org/repo.git')).toBe(
      'https://github.com/org/[repo]'
    );
    expect(scrubUrl('postgresql://app:hunter2@db.internal:5432/classmoji?sslmode=require')).toBe(
      'postgresql://db.internal:5432/classmoji'
    );
  });

  it('rewrites the join link code', () => {
    expect(scrubUrl('https://classmoji.io/join/Ab3xYz')).toBe('https://classmoji.io/join/[code]');
    expect(scrubUrl('/join/Ab3xYz.data?_routes=routes%2Fjoin')).toBe('/join/[code]');
    expect(scrubUrl('/join/Ab3xYz/extra')).toBe('/join/[code]/extra');
  });

  it('rewrites the calendar feed signature', () => {
    expect(scrubUrl('https://classmoji.io/api/calendar/cs52-f26/deadbeefcafe.ics')).toBe(
      'https://classmoji.io/api/calendar/cs52-f26/[signature]'
    );
  });

  it('rewrites a password reset token', () => {
    expect(scrubUrl('https://classmoji.io/api/auth/reset-password/RESETTOKEN?callbackURL=/x')).toBe(
      'https://classmoji.io/api/auth/reset-password/[token]'
    );
    expect(scrubUrl('/reset-password/RESETTOKEN')).toBe('/reset-password/[token]');
    // better-auth's own POST path has no token segment and stays as it is.
    expect(scrubUrl('/api/auth/email-otp/reset-password')).toBe(
      '/api/auth/email-otp/reset-password'
    );
  });

  it('rewrites signed content theme and files paths', () => {
    expect(
      scrubUrl(
        'https://content.classmoji.io/c/cls_1/theme/dark/abc123/month.1.1767225600.SIGSIG/css/a.css'
      )
    ).toBe('https://content.classmoji.io/c/cls_1/theme/dark/abc123/[sig]/css/a.css');
    expect(scrubUrl('/c/cls_1/files/GRANTSEG/month.1.1767225600.SIGSIG/docs/x.pdf')).toBe(
      '/c/cls_1/files/[grant]/[sig]/docs/x.pdf'
    );
    // Blob and media URLs carry their signature in the query only.
    expect(scrubUrl('/c/cls_1/blob/abc.png?p=month&v=1&exp=1&sig=SIG')).toBe(
      '/c/cls_1/blob/abc.png'
    );
  });

  it('redacts tokens in any other path segment', () => {
    expect(scrubUrl('/x/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln/y')).toBe('/x/[jwt]/y');
    expect(scrubUrl('/hooks/askmoji_abcDEF123')).toBe('/hooks/askmoji_[redacted]');
  });

  it('keeps only the media type of a data URL', () => {
    expect(scrubUrl('data:image/png;base64,AAAA')).toBe('data:image/png,[data]');
  });

  it('leaves ordinary URLs alone', () => {
    expect(scrubUrl('https://classmoji.io/admin/cs52/assignments/42')).toBe(
      'https://classmoji.io/admin/cs52/assignments/42'
    );
    expect(scrubUrl('')).toBe('');
  });

  it('documents one rule per sensitive path', () => {
    expect(SENSITIVE_PATHS.map(rule => rule.name)).toEqual([
      'join link code',
      'calendar feed signature',
      'password reset token',
      'content theme signature',
      'content files grant and signature',
      'student login',
      'staff login',
      'team slug',
      'repository name',
      'Gitlab project path',
      'Github API repository',
      'Github API collaborator',
      'Github API user',
      'Github API org member',
      'Github API team',
      'Github API team member',
      'Github repository',
      'Github avatar',
      'person id (admin app)',
    ]);
  });

  it('rewrites path segments that name a person', () => {
    expect(scrubUrl('https://classmoji.io/admin/cs52/students/jane-doe')).toBe(
      'https://classmoji.io/admin/cs52/students/[login]'
    );
    expect(scrubUrl('/teacher/cs52/students/jane-doe.data?_routes=x')).toBe(
      '/teacher/cs52/students/[login]'
    );
    expect(scrubUrl('/admin/cs52/staff/prof-x/edit')).toBe('/admin/cs52/staff/[login]/edit');
    expect(scrubUrl('/student/cs52/repos/hw1-jane-doe/team')).toBe(
      '/student/cs52/repos/[repo]/team'
    );
    expect(scrubUrl('/admin/cs52/teams/jane-and-joe/edit')).toBe('/admin/cs52/teams/[team]/edit');
    expect(scrubUrl('https://api.github.com/repos/cs52-org/hw1-jane-doe/contents/x')).toBe(
      'https://api.github.com/repos/cs52-org/[repo]/contents/x'
    );
    expect(scrubUrl('https://github.com/cs52-org/hw1-jane-doe.git')).toBe(
      'https://github.com/cs52-org/[repo]'
    );
    expect(
      scrubUrl('https://gitlab.example.edu/api/v4/projects/cs52%2Fprojects%2Fhw1-jane/repository')
    ).toBe('https://gitlab.example.edu/api/v4/projects/[project]/repository');
    expect(scrubUrl('https://admin.classmoji.io/people/user_123')).toBe(
      'https://admin.classmoji.io/people/[id]'
    );
    // Classroom slugs and record ids stay.
    expect(scrubUrl('/admin/cs52/students')).toBe('/admin/cs52/students');
    expect(scrubUrl('/admin/cs52/assignments/42')).toBe('/admin/cs52/assignments/42');
    expect(scrubUrl('/cs52/forms/survey/teams/set-1')).toBe('/cs52/forms/survey/teams/set-1');
  });

  it('matches paths case-insensitively and through percent-encoding', () => {
    expect(scrubUrl('/JOIN/ABC')).toBe('/JOIN/[code]');
    expect(scrubUrl('/%6Aoin/ABC')).toBe('/%6Aoin/[code]');
    expect(scrubUrl('/api/auth/Reset-Password/T0KEN')).toBe('/api/auth/Reset-Password/[token]');
    expect(scrubUrl('/Admin/cs52/%53tudents/jane')).toBe('/Admin/cs52/%53tudents/[login]');
    // An encoded slash stays inside its segment.
    expect(scrubUrl('/join%2Fabc')).toBe('/join%2Fabc');
    // A segment that does not decode is not sent.
    expect(scrubUrl('/join/%E0%A4%A')).toBe('/join/[segment]');
    expect(() => scrubUrl('/%/%%/x')).not.toThrow();
  });
});

describe('scrubText', () => {
  it('scrubs people-naming paths inside messages, case-insensitively', () => {
    expect(scrubText('No route matches URL "/ADMIN/cs52/students/jane"')).toBe(
      'No route matches URL "/ADMIN/cs52/students/[login]"'
    );
  });

  it('redacts secrets written as key: value, JSON, headers and env pairs', () => {
    // A quoted value always; a bare one after a name that can only be a
    // secret (password, secret, api key) however short; else at 12+ characters.
    expect(scrubText('login failed, password: hunter2-Secret-2024')).toBe(
      'login failed, password: [redacted]'
    );
    expect(scrubText('login failed, password: hunter2')).toBe('login failed, password: [redacted]');
    expect(scrubText('body {"password":"hunter2","id":"u1"}')).toBe(
      'body {"password":[redacted],"id":"u1"}'
    );
    expect(scrubText('{"password": "hunter 2"}')).toBe('{"password": [redacted]}');
    expect(scrubText("config { client_secret: 'abc123' }")).toBe(
      'config { client_secret: [redacted] }'
    );
    // A header loses its credential, up to the value's end, not the prose after it.
    expect(scrubText('sent x-collab-secret: s3cr3t to collab')).toBe(
      'sent x-collab-secret: [redacted] to collab'
    );
    expect(scrubText('env SOME_SECRET=abc123def456ghi OTHER=1')).toBe(
      'env SOME_SECRET=[redacted] OTHER=1'
    );
    expect(scrubText('env SOME_SECRET=abc OTHER=1')).toBe('env SOME_SECRET=[redacted] OTHER=1');
    expect(scrubText('RESEND_API_KEY="re_x" and GITHUB_TOKEN: 0123456789abcdef')).toBe(
      'RESEND_API_KEY=[redacted] and GITHUB_TOKEN: [redacted]'
    );
    // A join code is 16 base64url characters.
    expect(scrubText('joinCode=Ab3xYz09_-Ab3xYz0')).toBe('joinCode=[redacted]');
  });

  it('redacts Resend and AWS keys and Stripe signature values', () => {
    expect(scrubText('key re_123abc45_ABCDEFGHIJKLMNOPQRSTUVWX rejected')).toBe(
      'key [api-key] rejected'
    );
    expect(scrubText('aws AKIAIOSFODNN7EXAMPLE denied')).toBe('aws [aws-key] denied');
    expect(scrubText('Signature: t=1700000000,v1=abcdef0123,v0=99ff bad')).toBe(
      'Signature: [signature] bad'
    );
    // The signature rule already replaced the value, so the header has nothing left.
    expect(scrubText('stripe-signature: t=1,v1=ab')).toBe('stripe-signature: [signature]');
  });

  it('leaves ordinary diagnostics alone', () => {
    expect(scrubText('request failed with status code: 500')).toBe(
      'request failed with status code: 500'
    );
    expect(scrubText('token expired at 12:30')).toBe('token expired at 12:30');
    expect(scrubText('re_render failed')).toBe('re_render failed');
  });

  it('scrubs URLs inside a message', () => {
    expect(scrubText('fetch https://x.test/join/SECRET?invite=abc failed.')).toBe(
      'fetch https://x.test/join/[code] failed.'
    );
  });

  it('scrubs bare credential paths and their query strings', () => {
    expect(scrubText('No route matches URL "/join/SECRET?invite=abc"')).toBe(
      'No route matches URL "/join/[code]"'
    );
    expect(scrubText('GET /api/calendar/cs52/SIG.ics 500')).toBe(
      'GET /api/calendar/cs52/[signature] 500'
    );
  });

  it('redacts authorization values', () => {
    // After `Authorization:` / `authorization=` the credential goes at any length.
    expect(scrubText('sent Authorization: Bearer abc.def-123')).toBe(
      'sent Authorization: Bearer [redacted]'
    );
    expect(scrubText('sent authorization=Basic ab then')).toBe(
      'sent authorization=Basic [redacted] then'
    );
    // A bare credential needs 16+ characters.
    expect(scrubText('sent Bearer abc.def-1234567890XYZ')).toBe('sent Bearer [redacted]');
    expect(scrubText('Basic dXNlcjpwYXNzd29yZDEyMw== rejected')).toBe('Basic [redacted] rejected');
  });

  it('redacts JWTs and askmoji tokens', () => {
    expect(scrubText('token eyJhbGciOi.SECRET.JWT expired')).toBe('token [jwt] expired');
    expect(scrubText('bad askmoji_0123abcdEF-_x')).toBe('bad askmoji_[redacted]');
  });

  it('redacts git provider tokens', () => {
    for (const token of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abc',
      'ghu_abc',
      'ghs_abc',
      'ghr_abc',
      'github_pat_11ABC_def',
    ]) {
      expect(scrubText(`x ${token} y`)).toBe('x [github-token] y');
    }
    expect(scrubText('x glpat-abc_DEF-123 y')).toBe('x [gitlab-token] y');
    expect(scrubText('x gloas-abc y')).toBe('x [gitlab-token] y');
  });

  it('redacts Stripe, webhook and AI provider keys', () => {
    expect(scrubText('sk_live_abc123 sk_test_abc rk_live_abc rk_test_abc')).toBe(
      '[stripe-key] [stripe-key] [stripe-key] [stripe-key]'
    );
    expect(scrubText('secret whsec_abc+/=123')).toBe('secret [webhook-secret]');
    expect(scrubText('key sk-ant-api03-abc_DEF')).toBe('key [api-key]');
    expect(scrubText('key sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe('key [api-key]');
  });

  it('strips passwords from database URLs', () => {
    expect(scrubText('connect postgres://user:p4ss@ep-x.neon.tech/db?sslmode=require failed')).toBe(
      'connect postgres://ep-x.neon.tech/db failed'
    );
  });

  it('redacts session cookies and secret key=value pairs', () => {
    expect(scrubText('Cookie: better-auth.session_token=abc.def; theme=dark')).toBe(
      'Cookie: [redacted]'
    );
    expect(scrubText('__Secure-better-auth.session_data=xyz')).toBe(
      '__Secure-better-auth.session_data=[redacted]'
    );
    expect(
      scrubText('retry with token=abc123def456ghi&code=def, password=hunter2-Secret-2024')
    ).toBe('retry with token=[redacted]&code=def, password=[redacted]');
    // A short token is a word (12+ rule), `code` is a diagnostic; a password is a password.
    expect(scrubText('retry with token=abc&code=def, password=hunter2')).toBe(
      'retry with token=abc&code=def, password=[redacted]'
    );
  });

  it('redacts email addresses', () => {
    expect(scrubText('no user ada@example.edu in roster')).toBe('no user [email] in roster');
  });

  it('redacts public IP addresses and keeps internal ones', () => {
    expect(scrubText('rate limited 203.0.113.9 and 2001:db8::1')).toBe(
      'rate limited [ip] and [ip]'
    );
    expect(scrubText('ECONNREFUSED 127.0.0.1:5432 10.0.0.2 192.168.1.1 172.16.0.1')).toBe(
      'ECONNREFUSED 127.0.0.1:5432 10.0.0.2 192.168.1.1 172.16.0.1'
    );
    expect(scrubText('fdaa:0:1::2 and ::1')).toBe('fdaa:0:1::2 and ::1');
    // Clock times and Rust-like paths are not addresses.
    expect(scrubText('at 12:30:45, Foo::bar')).toBe('at 12:30:45, Foo::bar');
  });

  it('leaves ordinary messages alone', () => {
    const message =
      "Cannot read properties of undefined (reading 'id') at /app/build/server/index.js:12:3";
    expect(scrubText(message)).toBe(message);
    expect(scrubText('')).toBe('');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'user typed secret' })).toBeNull();
  });

  it('scrubs http and fetch breadcrumbs', () => {
    const breadcrumb: Breadcrumb = {
      category: 'http',
      type: 'http',
      data: {
        url: 'https://api.github.com/repos/x/y?access_token=ghs_abc',
        method: 'GET',
        status_code: 500,
        'http.query': '?access_token=ghs_abc',
        'url.query': 'access_token=ghs_abc',
        'http.fragment': 'x',
      },
    };
    expect(scrubBreadcrumb(breadcrumb)).toEqual({
      category: 'http',
      type: 'http',
      data: { url: 'https://api.github.com/repos/x/[repo]', method: 'GET', status_code: 500 },
    });
    expect(
      scrubBreadcrumb({ category: 'fetch', data: { url: '/join/CODE?x=1', method: 'POST' } })
    ).toEqual({ category: 'fetch', data: { url: '/join/[code]', method: 'POST' } });
  });

  it('scrubs messages and navigation endpoints', () => {
    expect(
      scrubBreadcrumb({
        category: 'navigation',
        message: 'to /join/CODE',
        data: { from: '/a?x=1', to: '/join/CODE' },
      })
    ).toEqual({
      category: 'navigation',
      message: 'to /join/[code]',
      data: { from: '/a', to: '/join/[code]' },
    });
  });
});

describe('scrubEvent', () => {
  it('removes everything about the request but its method and scrubbed URL', () => {
    const event = scrubEvent({
      request: {
        method: 'POST',
        url: 'https://classmoji.io/join/CODE?invite=abc',
        query_string: 'invite=abc',
        headers: { cookie: 'session=x', authorization: 'Bearer y' },
        cookies: { session: 'x' },
        data: '{"secret":1}',
        env: { REMOTE_ADDR: '203.0.113.9' },
      },
    } as unknown as ErrorEvent);
    expect(event.request).toEqual({ method: 'POST', url: 'https://classmoji.io/join/[code]' });
  });

  it('reduces the user to an id, or removes it', () => {
    expect(
      scrubEvent({
        user: { id: 'u1', email: 'a@b.co', ip_address: '203.0.113.9', username: 'ada' },
      } as ErrorEvent).user
    ).toEqual({ id: 'u1' });
    const anonymous = scrubEvent({ user: { ip_address: '{{auto}}' } } as ErrorEvent);
    expect(anonymous).not.toHaveProperty('user');
  });

  it('scrubs the transaction, messages and exception values', () => {
    const event = scrubEvent({
      transaction: 'GET /join/CODE',
      message: 'see https://x.test/join/CODE?y=1',
      logentry: { message: 'user %s', params: ['ada@example.edu'] },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Bearer abcdefghijklmnop123 at /join/CODE',
            stacktrace: { frames: [{ filename: 'a.js', vars: { password: 'x' } }] },
          },
        ],
      },
    } as unknown as ErrorEvent);
    expect(event.transaction).toBe('GET /join/[code]');
    expect(event.message).toBe('see https://x.test/join/[code]');
    expect(event.logentry).toEqual({ message: 'user %s', params: ['[email]'] });
    expect(event.exception?.values?.[0].value).toBe('Bearer [redacted] at /join/[code]');
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0]).toEqual({ filename: 'a.js' });
  });

  it('scrubs breadcrumbs, tags, extra and contexts', () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: 'console', message: 'x' },
        { category: 'http', data: { url: '/join/CODE?x=1' } },
      ],
      tags: { surface: 'audit.write', url: '/join/CODE', count: 3 },
      extra: {
        note: 'from 203.0.113.9',
        headers: { cookie: 'x' },
        nested: { token: 'abc', url: 'https://a.test/b?c=d', error: new Error('ada@example.edu') },
      },
      contexts: { response: { status_code: 500, headers: { 'set-cookie': 'x' } } },
      server_name: 'e28650dc2d1428',
    } as unknown as ErrorEvent);
    expect(event.breadcrumbs).toEqual([{ category: 'http', data: { url: '/join/[code]' } }]);
    expect(event.tags).toEqual({ surface: 'audit.write', url: '/join/[code]', count: 3 });
    expect(event.extra).toEqual({
      note: 'from [ip]',
      nested: { url: 'https://a.test/b', error: { name: 'Error', message: '[email]' } },
    });
    expect(event.contexts).toEqual({ response: { status_code: 500 } });
    // An opaque machine id: kept.
    expect(event.server_name).toBe('e28650dc2d1428');
  });

  it("drops what a Worker's request.cf says about the visitor", () => {
    // The shape @sentry/cloudflare 11 builds on workerd: cloud_resource and
    // culture.timezone (from request.cf) on the isolation scope, the request's
    // headers (Cloudflare adds cf-connecting-ip, cf-ipcountry, cf-ray) in
    // event.request, and anything an integration might copy from request.cf.
    const event = scrubEvent({
      request: {
        method: 'GET',
        url: 'https://content.classmoji.io/c/1/theme/t/x/p.v.1.sig/a.css',
        headers: {
          'cf-connecting-ip': '203.0.113.9',
          'cf-ipcountry': 'US',
          'cf-ray': '8f00-EWR',
          'user-agent': 'Mozilla/5.0',
        },
      },
      user: {
        id: 'u1',
        ip_address: '203.0.113.9',
        geo: { city: 'Hanover', country_code: 'US', region: 'New Hampshire' },
      },
      contexts: {
        cloud_resource: { 'cloud.provider': 'cloudflare' },
        culture: { timezone: 'America/New_York' },
        geo: { city: 'Hanover', country_code: 'US' },
        cf: {
          colo: 'EWR',
          asn: 7922,
          city: 'Hanover',
          latitude: '43.7',
          timezone: 'America/New_York',
        },
        response: { status_code: 500 },
        trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) },
      },
    } as unknown as ErrorEvent);
    expect(event.request).toEqual({
      method: 'GET',
      url: 'https://content.classmoji.io/c/1/theme/t/x/[sig]/a.css',
    });
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.contexts).toEqual({
      cloud_resource: { 'cloud.provider': 'cloudflare' },
      response: { status_code: 500 },
      trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) },
    });
    expect(JSON.stringify(event)).not.toMatch(/New_York|Hanover|EWR|7922|203\.0\.113\.9/);
  });
});

describe('shouldReportRouteError', () => {
  it('skips aborted requests', () => {
    expect(shouldReportRouteError(new Error('x'), { signal: { aborted: true } })).toBe(false);
    expect(shouldReportRouteError(new Error('x'), { signal: { aborted: false } })).toBe(true);
    expect(shouldReportRouteError(new Error('x'))).toBe(true);
  });

  it('skips Responses below 500 and reports 5xx', () => {
    expect(shouldReportRouteError(new Response(null, { status: 302 }))).toBe(false);
    expect(shouldReportRouteError(new Response(null, { status: 404 }))).toBe(false);
    expect(shouldReportRouteError(new Response(null, { status: 503 }))).toBe(true);
  });

  it('skips route error responses below 500 and reports 5xx', () => {
    const response = (status: number) => ({ status, statusText: 'x', internal: false, data: null });
    expect(shouldReportRouteError(response(403))).toBe(false);
    expect(shouldReportRouteError(response(500))).toBe(true);
  });

  it('reports everything else', () => {
    expect(shouldReportRouteError('a string')).toBe(true);
    expect(shouldReportRouteError({ status: 404 })).toBe(true);
    expect(shouldReportRouteError(null)).toBe(true);
  });
});

describe('reportRouteError', () => {
  type Report = { error: unknown; context: ReportContext };
  let reports: Report[] = [];
  const withReporter = () => {
    reports = [];
    setErrorReporter({
      capture: (error, context) => {
        reports.push({ error, context });
      },
      flush: async () => true,
    });
  };
  const request = (aborted = false) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    return new Request('https://app.test/x', { signal: controller.signal });
  };
  const run = (error: unknown, req = request(), mode = 'production') => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRouteError(error, req, { mode });
    const logged = log.mock.calls;
    log.mockRestore();
    return logged;
  };
  // What React Router's ErrorResponseImpl looks like to isRouteErrorResponse.
  const routeErrorResponse = (status: number, error?: Error) => ({
    status,
    statusText: 'x',
    internal: true,
    data: 'd',
    ...(error ? { error } : {}),
  });
  const HANDLE_ERROR = { surface: 'react_router.handle_error', handled: false };

  afterEach(() => setErrorReporter(null));

  it('logs the error as the default does and reports it once, as unhandled', () => {
    withReporter();
    const error = new Error('loader broke');
    expect(run(error)).toEqual([[error]]);
    run(error);
    expect(reports).toEqual([{ error, context: HANDLE_ERROR }]);
  });

  it('does not report what a choke point or captureServerException already sent', () => {
    withReporter();
    const error = new Error('seen');
    reportError(error, { surface: 'audit.write' });
    run(error);
    const marked = new Error('marked');
    markReported(marked);
    run(marked);
    expect(reports.map(r => r.context.surface)).toEqual(['audit.write']);
  });

  it("logs a route error response's inner Error, reports 5xx, not 4xx", () => {
    withReporter();
    const inner = new Error('inner');
    const failed = routeErrorResponse(500, inner);
    expect(run(failed)).toEqual([[inner]]);
    const notFound = routeErrorResponse(404);
    expect(run(notFound)).toEqual([[notFound]]);
    expect(reports).toEqual([{ error: failed, context: HANDLE_ERROR }]);
  });

  it('reports a thrown 5xx Response as the Error naming its status, once', () => {
    withReporter();
    const response = new Response('down', { status: 503, statusText: 'Service Unavailable' });
    expect(run(response)).toEqual([[response]]);
    run(response);
    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe('Response 503 Service Unavailable');
    expect(reports[0].context).toEqual(HANDLE_ERROR);
  });

  it('logs but does not report a thrown 4xx Response or redirect', () => {
    withReporter();
    const forbidden = new Response(null, { status: 403 });
    expect(run(forbidden)).toEqual([[forbidden]]);
    run(new Response(null, { status: 302, headers: { Location: '/' } }));
    expect(reports).toEqual([]);
  });

  it('neither logs nor reports for an aborted request', () => {
    withReporter();
    expect(run(new Error('gone'), request(true))).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('does not log in test mode (as the default), and still reports', () => {
    withReporter();
    expect(run(new Error('quiet'), request(), 'test')).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it('without a reporter only logs, and never throws', () => {
    const error = new Error('off');
    expect(run(error)).toEqual([[error]]);
    const response = new Response(null, { status: 500 });
    expect(() => run(response)).not.toThrow();
    // The Response was not marked: a reporter registered later still gets it.
    withReporter();
    run(response);
    expect(reports).toHaveLength(1);
  });
});

describe('toReportableError', () => {
  it('keeps Errors and names what else it was given', () => {
    const error = new Error('x');
    expect(toReportableError(error)).toBe(error);
    expect(toReportableError('boom').message).toBe('boom');
    expect(
      toReportableError(new Response(null, { status: 502, statusText: 'Bad Gateway' })).message
    ).toBe('Response 502 Bad Gateway');
    const inner = new Error('inner');
    expect(
      toReportableError({ status: 500, statusText: '', internal: true, data: null, error: inner })
    ).toBe(inner);
    expect(toReportableError({ email: 'ada@example.edu' }).message).toBe(
      'Non-Error value reported ([object Object])'
    );
  });
});

describe('createSentryReporter / captureWithContext', () => {
  const makeSdk = () => {
    const scope = { setTag: vi.fn(), setLevel: vi.fn(), setExtras: vi.fn() };
    const sdk = {
      withScope: vi.fn((callback: (s: typeof scope) => void) => callback(scope)),
      captureException: vi.fn(),
      flush: vi.fn(async () => true),
    };
    return { scope, sdk };
  };

  it('sets surface, tags, level, scrubbed extras and the mechanism', () => {
    const { scope, sdk } = makeSdk();
    const error = new Error('x');
    createSentryReporter(sdk).capture(error, {
      surface: 'audit.write',
      level: 'warning',
      tags: { classroom_id: 'c1', count: 2, skipped: undefined, path: '/join/CODE' },
      extra: { attempts: 3, headers: { cookie: 'x' }, note: 'Bearer abcdefghijklmnop123' },
    });
    expect(scope.setTag.mock.calls).toEqual([
      ['surface', 'audit.write'],
      ['classroom_id', 'c1'],
      ['count', 2],
      ['path', '/join/[code]'],
    ]);
    expect(scope.setLevel).toHaveBeenCalledWith('warning');
    expect(scope.setExtras).toHaveBeenCalledWith({ attempts: 3, note: 'Bearer [redacted]' });
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      mechanism: { type: 'generic', handled: true },
    });
  });

  it('defaults to error level and reports unhandled when told', () => {
    const { scope, sdk } = makeSdk();
    captureWithContext(sdk, 'thrown string', {
      surface: 'process.unhandled_rejection',
      handled: false,
    });
    expect(scope.setLevel).toHaveBeenCalledWith('error');
    expect(scope.setExtras).not.toHaveBeenCalled();
    const [sent, hint] = sdk.captureException.mock.calls[0] as unknown as [Error, unknown];
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toBe('thrown string');
    expect(hint).toEqual({ mechanism: { type: 'generic', handled: false } });
  });

  it('flushes through the SDK', async () => {
    const { sdk } = makeSdk();
    await createSentryReporter(sdk).flush(500);
    expect(sdk.flush).toHaveBeenCalledWith(500);
  });
});

describe('isSecretKey', () => {
  it.each([
    'authToken',
    'sessionToken',
    'session_token',
    'apiSecret',
    'credentials',
    'jwt',
    'joinCode',
    'join_code',
    'shareCode',
    'invite',
    'x-collab-secret',
    'Authorization',
    'cookie',
    'private_key',
    'stripe_signature',
  ])('drops %s', key => expect(isSecretKey(key)).toBe(true));

  it.each([
    'status_code',
    'filter_key',
    'tokens_per_hour',
    'error_code',
    'code',
    'tokenCount',
    'tokenizer',
    'cookieConsent',
    'signatureVersion',
    'classroom_id',
    'surface',
    'count',
  ])('keeps %s', key => expect(isSecretKey(key)).toBe(false));

  it('drops them from extra and contexts', () => {
    const event = scrubEvent({
      extra: { authToken: 't', status_code: 500, nested: { apiSecret: 's', tokens_per_hour: 2 } },
      contexts: { app: { credentials: 'x', filter_key: 'k' } },
    });
    expect(event.extra).toEqual({ status_code: 500, nested: { tokens_per_hour: 2 } });
    expect(event.contexts).toEqual({ app: { filter_key: 'k' } });
  });
});

describe('scrubEvent: fingerprint, exception type and mechanism data', () => {
  it('scrubs each through scrubText', () => {
    const event = scrubEvent({
      fingerprint: ['{{ default }}', '/join/CODE', 'jane@school.edu'],
      exception: {
        values: [
          {
            type: 'Error at /admin/cs52/students/jane',
            value: 'x',
            mechanism: { data: { url: '/join/CODE?x=1', handler: 'jane@school.edu' } },
          },
        ],
      },
    });
    expect(event.fingerprint).toEqual(['{{ default }}', '/join/[code]', '[email]']);
    expect(event.exception?.values?.[0].type).toBe('Error at /admin/cs52/students/[login]');
    expect(event.exception?.values?.[0].mechanism?.data).toEqual({
      url: '/join/[code]',
      handler: '[email]',
    });
  });
});

describe('isOriginRefusal / shouldReportRouteError for React Router refusals', () => {
  const MISMATCH =
    'The `request.url` origin does not match `origin` header from a forwarded action request. Aborting the action.';
  const post = (origin: string | null, url = 'https://classmoji.io/admin/cs52/settings') =>
    new Request(url, { method: 'POST', headers: origin === null ? {} : { origin } });

  it('skips the document POST refusal (origin mismatch, answered 400)', () => {
    const request = post('https://evil.example');
    expect(isOriginRefusal(new Error(MISMATCH), request)).toBe(true);
    expect(shouldReportRouteError(new Error(MISMATCH), request)).toBe(false);
  });

  it('skips an origin header that is not a URL', () => {
    const error = new Error('`origin` header is not a valid URL. Aborting the action.');
    expect(shouldReportRouteError(error, post('not a url'))).toBe(false);
  });

  it('skips the .data POST refusal (new Error("Bad Request"))', () => {
    const request = post('https://evil.example', 'https://classmoji.io/admin/cs52/settings.data');
    expect(shouldReportRouteError(new Error('Bad Request'), request)).toBe(false);
  });

  it('skips Origin: null and an empty Origin, which React Router refuses too', () => {
    // React Router compares the string "null" with the request's host, and
    // an empty value fails to parse: both are refused, by anyone, signed out.
    expect(shouldReportRouteError(new Error(MISMATCH), post('null'))).toBe(false);
    expect(shouldReportRouteError(new Error('Bad Request'), post('null'))).toBe(false);
    const invalid = '`origin` header is not a valid URL. Aborting the action.';
    expect(shouldReportRouteError(new Error(invalid), post(''))).toBe(false);
  });

  it("reports a same-host POST behind Fly's TLS proxy (https Origin, http request.url)", () => {
    // React Router lets this through (the host is in allowedActionOrigins),
    // so a "Bad Request" here is the action's own failure.
    const proxied = post('https://classmoji.io', 'http://classmoji.io/admin/cs52/settings');
    expect(isOriginRefusal(new Error('Bad Request'), proxied)).toBe(false);
    expect(shouldReportRouteError(new Error('Bad Request'), proxied)).toBe(true);
    // Another host is refused, whatever the scheme or port.
    expect(
      isOriginRefusal(
        new Error('Bad Request'),
        post('http://classmoji.io:8443', 'http://classmoji.io/x')
      )
    ).toBe(true);
    expect(
      isOriginRefusal(new Error(MISMATCH), post('https://evil.example', 'http://classmoji.io/x'))
    ).toBe(true);
  });

  it("skips React Router's long messages on any mutation with an Origin, whatever the host", () => {
    // A host that reaches the app but is not in ACTION_ORIGIN_HOSTS (the
    // *.fly.dev name) is refused for the scheme alone behind Fly's proxy.
    const flyDev = post('https://app.fly.dev', 'http://app.fly.dev/admin/cs52/settings');
    expect(shouldReportRouteError(new Error(MISMATCH), flyDev)).toBe(false);
    // No Origin: React Router never throws it then, so it is not its refusal.
    expect(shouldReportRouteError(new Error(MISMATCH), post(null))).toBe(true);
  });

  it('skips React Router\'s own .data "Bad Request" by where it was made, on any host', () => {
    // What react-router's singleFetchAction does after a refused origin check.
    const singleFetchAction = () => new Error('Bad Request');
    const flyDev = post('https://app.fly.dev', 'http://app.fly.dev/admin/cs52/settings.data');
    expect(shouldReportRouteError(singleFetchAction(), flyDev)).toBe(false);
    // The same message made by an action on that request is reported.
    expect(shouldReportRouteError(new Error('Bad Request'), flyDev)).toBe(true);
  });

  it('still reports the same message on a same-origin request, a GET, or a subclass', () => {
    expect(shouldReportRouteError(new Error('Bad Request'), post('https://classmoji.io'))).toBe(
      true
    );
    // No Origin at all: React Router does not refuse it.
    expect(shouldReportRouteError(new Error('Bad Request'), post(null))).toBe(true);
    for (const origin of ['null', 'https://evil.example']) {
      const get = new Request('https://classmoji.io/x', { headers: { origin } });
      expect(shouldReportRouteError(new Error(MISMATCH), get)).toBe(true);
    }
    const get = new Request('https://classmoji.io/x', {
      headers: { origin: 'https://evil.example' },
    });
    expect(shouldReportRouteError(new Error('Bad Request'), get)).toBe(true);
    class Custom extends Error {}
    expect(shouldReportRouteError(new Custom('Bad Request'), post('https://evil.example'))).toBe(
      true
    );
    expect(shouldReportRouteError(new Error('database down'), post('https://evil.example'))).toBe(
      true
    );
  });

  it('logs the refusal as before but does not report it', () => {
    const captured: unknown[] = [];
    setErrorReporter({ capture: error => void captured.push(error), flush: async () => true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = new Error(MISMATCH);
      reportRouteError(error, post('https://evil.example'), { mode: 'production' });
      expect(log).toHaveBeenCalledWith(error);
      expect(captured).toEqual([]);
    } finally {
      log.mockRestore();
      setErrorReporter(null);
    }
  });
});

describe('reportRenderError', () => {
  const capture = () => {
    const captured: Array<{ error: unknown; context: ReportContext }> = [];
    setErrorReporter({
      capture: (error, context) => void captured.push({ error, context }),
      flush: async () => true,
    });
    return captured;
  };
  afterEach(() => setErrorReporter(null));

  it('reports a real render error once, as react_router.render (unhandled)', () => {
    const captured = capture();
    const error = new Error('render boom');
    reportRenderError(error, new Request('https://x.test/'));
    reportRenderError(error, new Request('https://x.test/'));
    expect(captured).toEqual([
      { error, context: { surface: 'react_router.render', handled: false } },
    ]);
  });

  it('skips a client that went away, the stream timeout and an aborted request', () => {
    const captured = capture();
    reportRenderError(new Error('The destination stream closed early.'));
    reportRenderError(new Error('The render was aborted by the server without a reason.'));
    reportRenderError(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    reportRenderError(new Error('anything'), { signal: controller.signal });
    expect(captured).toEqual([]);
  });

  it("reports a TimeoutError that is not the entry's own (an upstream fetch timing out)", () => {
    const captured = capture();
    const upstream = new DOMException('The operation timed out.', 'TimeoutError');
    reportRenderError(upstream);
    expect(captured.map(c => c.error)).toEqual([upstream]);
  });

  it('isRenderAbort is exact: a subclass or another message is a real error', () => {
    class Custom extends Error {}
    expect(isRenderAbort(new Custom('The destination stream closed early.'))).toBe(false);
    expect(isRenderAbort(new Error('The destination stream closed early'))).toBe(false);
  });

  it('does nothing without a reporter', () => {
    expect(() => reportRenderError(new Error('x'))).not.toThrow();
  });
});
