import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Breadcrumb, ErrorEvent } from '@sentry/core';
import { markReported, reportError, setErrorReporter, type ReportContext } from '../errorReport.ts';
import {
  CREDENTIAL_PATHS,
  captureWithContext,
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
    expect(options.initialScope).toEqual({ tags: { app: 'mcp', runtime: 'server' } });
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
      'https://github.com/org/repo.git'
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

  it('documents one rule per credential path', () => {
    expect(CREDENTIAL_PATHS.map(rule => rule.name)).toEqual([
      'join link code',
      'calendar feed signature',
      'password reset token',
      'content theme signature',
      'content files grant and signature',
    ]);
  });
});

describe('scrubText', () => {
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
    expect(scrubText('sent Authorization: Bearer abc.def-123')).toBe(
      'sent Authorization: Bearer [redacted]'
    );
    expect(scrubText('Basic dXNlcjpwYXNz rejected')).toBe('Basic [redacted] rejected');
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
      'Cookie: better-auth.session_token=[redacted]; theme=dark'
    );
    expect(scrubText('__Secure-better-auth.session_data=xyz')).toBe(
      '__Secure-better-auth.session_data=[redacted]'
    );
    expect(scrubText('retry with token=abc&code=def, password=hunter2')).toBe(
      'retry with token=[redacted]&code=[redacted], password=[redacted]'
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
      data: { url: 'https://api.github.com/repos/x/y', method: 'GET', status_code: 500 },
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
            value: 'Bearer abc at /join/CODE',
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
      extra: { attempts: 3, headers: { cookie: 'x' }, note: 'Bearer abc' },
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
