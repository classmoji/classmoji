/**
 * The scrubber's rules on hostile and on ordinary input:
 * - linear time: every exported scrubber over 100 KB of the shapes that make
 *   backtracking patterns quadratic (anyone can send a request path);
 * - length bounds with a visible marker;
 * - what it must NOT damage (browser versions, ordinary messages, keys that
 *   are diagnostics), pinned;
 * - V8's `JSON.parse` messages never keep the input they quote;
 * - SENSITIVE_PATHS against every app's real route files: no static segment
 *   is rewritten, and exactly the person/credential params are;
 * - logins inside Github API URLs that Octokit errors quote.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Breadcrumb } from '@sentry/core';
import {
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
  TRUNCATED,
  isSecretKey,
  scrubBreadcrumb,
  scrubBrowserEvent,
  scrubEvent,
  scrubText,
  scrubTransaction,
  scrubUrl,
  stripElementAttributes,
} from '../sentryScrub.ts';

// ---------------------------------------------------------------------------
// Linear time
// ---------------------------------------------------------------------------

const SIZE = 100_000;
const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

/** Shapes that make `[\w.-]*x`, `a+b+`, `\b…@…` and lazy `"…"` patterns backtrack. */
const ADVERSARIAL: Record<string, string> = Object.fromEntries(
  [
    'a-',
    'a.',
    '1.',
    'a@',
    '/a',
    '%41',
    'x-',
    '=',
    ':',
    'a-a.1@/x-=:%41',
    'eyJ-',
    '"a":',
    'token: ',
    'x-a-secret',
    'Bearer ',
    'authorization: Bearer a',
    'authorization: ',
    'cookie:',
    'Cookie: a=b;',
    'password:',
    'x-a-secret: a ',
    'eyJaaaaaaaaaa.',
    '[a="x"]x',
    '"x" is not valid JSON',
    'session_',
    '2001:',
    'a:1.',
    'http://',
    'a ',
  ].map(unit => [unit, repeat(unit)])
);

/** The fastest of a few runs (after one warm-up), in milliseconds. */
const fastest = (run: () => unknown): number => {
  run();
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

const LIMIT_MS = 50;

describe('linear time on hostile input (100 KB each)', () => {
  it.each(Object.keys(ADVERSARIAL))('scrubUrl, scrubText and stripElementAttributes: %j', unit => {
    const input = ADVERSARIAL[unit];
    expect(fastest(() => scrubUrl(input))).toBeLessThan(LIMIT_MS);
    expect(fastest(() => scrubUrl(`https://h.test/${input}`))).toBeLessThan(LIMIT_MS);
    expect(fastest(() => scrubTransaction(`GET /${input}`))).toBeLessThan(LIMIT_MS);
    expect(fastest(() => scrubText(input))).toBeLessThan(LIMIT_MS);
    expect(fastest(() => stripElementAttributes(input))).toBeLessThan(LIMIT_MS);
  });

  it.each(Object.keys(ADVERSARIAL))('scrubEvent and scrubBreadcrumb: %j', unit => {
    const input = ADVERSARIAL[unit];
    const event = () => ({
      transaction: input,
      message: input,
      request: { method: 'POST', url: `https://h.test/${input}`, headers: { 'User-Agent': input } },
      exception: { values: [{ type: 'Error', value: input }] },
      tags: { a: input },
      extra: { note: input, nested: { [unit]: input } },
      breadcrumbs: [{ category: 'http', message: input, data: { url: input } }],
    });
    expect(fastest(() => scrubEvent(event()))).toBeLessThan(LIMIT_MS);
    expect(fastest(() => scrubBrowserEvent(event()))).toBeLessThan(LIMIT_MS);
    expect(
      fastest(() => scrubBreadcrumb({ category: 'fetch', message: input, data: { url: input } }))
    ).toBeLessThan(LIMIT_MS);
  });

  it.each(Object.keys(ADVERSARIAL))(
    'the patterns themselves are linear: %j at exactly MAX_TEXT_LENGTH',
    unit => {
      // At the bound nothing is cut, so this times the patterns, not the cut
      // (a quadratic pattern takes tens of milliseconds here).
      const input = ADVERSARIAL[unit].slice(0, MAX_TEXT_LENGTH);
      expect(fastest(() => scrubText(input))).toBeLessThan(10);
      expect(fastest(() => scrubText(`see https://h.test/${input.slice(20)}`))).toBeLessThan(10);
    }
  );

  it('bounds the number of breadcrumbs, entries and keys it copies', () => {
    const many = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 'v']));
    const breadcrumbs: Breadcrumb[] = Array.from({ length: 5000 }, (_, i) => ({
      category: 'http',
      message: `b${i}`,
    }));
    const event = scrubEvent({
      extra: { many, list: Array.from({ length: 5000 }, () => 'x'), ['k'.repeat(200)]: 'v' },
      breadcrumbs,
    });
    const extra = event.extra as { many: object; list: unknown[] };
    expect(Object.keys(extra.many)).toHaveLength(100);
    expect(extra.list).toHaveLength(100);
    // An over-long key is dropped, never matched.
    expect(Object.keys(extra)).toEqual(['many', 'list']);
    // The latest breadcrumbs are the ones kept.
    expect(event.breadcrumbs).toHaveLength(100);
    expect(event.breadcrumbs?.[99].message).toBe('b4999');
  });
});

describe('length bounds', () => {
  it('cuts URLs and transaction names back to a whole segment, with a marker', () => {
    const long = `/admin/cs52/students/jane-doe/${'segment/'.repeat(100)}end`;
    const out = scrubUrl(`https://classmoji.io${long}?q=x`);
    expect(out.startsWith('https://classmoji.io/admin/cs52/students/[login]/segment/')).toBe(true);
    expect(out.endsWith(`/segment/${TRUNCATED}`)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_URL_LENGTH + 60);
    expect(scrubTransaction(`GET ${long}`)).toMatch(/^GET \/admin\/cs52\/students\/\[login\]\//);
    expect(scrubTransaction(`GET ${long}`).endsWith(TRUNCATED)).toBe(true);
    // A token cut in half is not left behind.
    const jwt = `eyJ${'a'.repeat(400)}.eyJ${'b'.repeat(400)}.sig`;
    expect(scrubUrl(`/x/${jwt}`)).toBe(`/x/${TRUNCATED}`);
  });

  it('cuts other text at a word boundary, dropping the word it lands in', () => {
    const text = `${'word '.repeat(MAX_TEXT_LENGTH / 5 - 1)}jane.doe@school.edu tail`;
    const out = scrubText(text);
    expect(out.endsWith(TRUNCATED)).toBe(true);
    expect(out).not.toMatch(/jane|school/);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH + TRUNCATED.length);
    expect(scrubText('short')).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// What the scrubber must leave alone
// ---------------------------------------------------------------------------

describe('secret values after a name', () => {
  it('redacts a header credential only, never the prose or the rest of the line', () => {
    for (const text of [
      'authorization: role STUDENT cannot edit c1',
      'authorization: token expired for c1',
      'cookie: missing from request',
      'Authorization: missing',
      'authorization: not allowed',
      'x-collab-secret: not set',
    ]) {
      expect(scrubText(text)).toBe(text);
    }
    expect(scrubText('headers: { Authorization: Bearer abc }, next: 1')).toBe(
      'headers: { Authorization: Bearer [redacted] }, next: 1'
    );
    expect(scrubText('Authorization: Token abc123 for x')).toBe(
      'Authorization: Token [redacted] for x'
    );
    expect(scrubText('x-gitlab-token: abc')).toBe('x-gitlab-token: [redacted]');
    expect(scrubText('x-api-key: abc')).toBe('x-api-key: [redacted]');
    // A scheme that is not listed: the credential after it still goes.
    expect(scrubText('Authorization: Splunk 0123456789abcdef0123')).toBe(
      'Authorization: Splunk [redacted]'
    );
    expect(scrubText('Authorization: ApiKey abc123')).toBe('Authorization: [redacted]');
    // A cookie header: every pair, whatever its name, and nothing after them.
    expect(scrubText('Cookie: theme=dark; sid=s3cr3tvalue tail')).toBe('Cookie: [redacted] tail');
  });

  it('after Authorization, Bearer and Basic go at any length, long and short alike', () => {
    expect(scrubText('Authorization: Bearer ab')).toBe('Authorization: Bearer [redacted]');
    expect(scrubText('Authorization: Bearer abcdefghijklmnop1234')).toBe(
      'Authorization: Bearer [redacted]'
    );
    expect(scrubText('proxy-authorization=basic dXNlcg== x')).toBe(
      'proxy-authorization=basic [redacted] x'
    );
    // Without the header name, 16+ only: prose stays.
    expect(scrubText('Bearer realm missing')).toBe('Bearer realm missing');
    // A stand-in is not wrapped again.
    expect(scrubText('Authorization: token ghp_abcdef y')).toBe(
      'Authorization: token [github-token] y'
    );
  });

  it.each([
    // Unambiguous names: after `=` always, after `:` 4+ characters or a
    // digit/capital, unless a word saying the value is absent.
    ['password=hunter2', 'password=[redacted]'],
    ['password=x', 'password=[redacted]'],
    ['password: hunter2', 'password: [redacted]'],
    ['secret: shortpw', 'secret: [redacted]'],
    ['secret: Ab1', 'secret: [redacted]'],
    ['COLLAB_INTERNAL_SECRET=short', 'COLLAB_INTERNAL_SECRET=[redacted]'],
    ['api_key=abc1', 'api_key=[redacted]'],
    ['apikey: abcd', 'apikey: [redacted]'],
    ['passwd=pw', 'passwd=[redacted]'],
    ['client_secret=abc', 'client_secret=[redacted]'],
    ['password=required', 'password=[redacted]'],
    ['secret=null', 'secret=[redacted]'],
    // Prose after them stays: a short word, or a word saying the value is absent.
    ['password: is too short', 'password: is too short'],
    ['secret: not set', 'secret: not set'],
    ['password: required', 'password: required'],
    ['password: undefined', 'password: undefined'],
    ['secret: null', 'secret: null'],
    // Other secret names keep the 12+ rule; `code` is a diagnostic.
    ['token: abc', 'token: abc'],
    ['token=abc123def456ghi', 'token=[redacted]'],
    ['DEPLOY_KEY: x', 'DEPLOY_KEY: x'],
    ['code=abcdef', 'code=abcdef'],
  ])('%j → %j', (text, expected) => expect(scrubText(text)).toBe(expected));

  it('redacts a two-part signed token (invite, class-site return)', () => {
    expect(scrubText('join eyJhbGciOiJIUzI1NiJ9.c2lnbmF0dXJlXzEyMzQ end')).toBe(
      'join [signed-token] end'
    );
    expect(scrubUrl('/site/return/eyJjbGFzcyI6ImNzNTIifQ.abcdefghijklmnop')).toBe(
      '/site/return/[signed-token]'
    );
    // Too short to be one.
    expect(scrubText('eyJ.x and eyJabc.def')).toBe('eyJ.x and eyJabc.def');
  });
});

describe('ordinary text stays as it was', () => {
  it.each([
    'Unexpected token: <',
    'Invalid token: jwt expired',
    'code=1',
    'request failed with status code: 500',
    'Bearer realm missing',
    'Basic auth required',
    'sk-short and sk-abcdefghijklmnopqrstuvwxyz0123',
    're_abcdefghijklmnopqrstu1 and re_render failed',
    'version 1.2.3.4.5 and v1.2.3.4 and build/10.0.0.1',
    'dead::beef ab:cd::ef Foo::bar 12:30:45 2024:01:15',
    'fdaa:0:1::2 and ::1 and fe80::1',
    "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
  ])('%j', text => expect(scrubText(text)).toBe(text));

  it('redacts a dotted quad standing on its own', () => {
    // 1.2.3.4 is a routable public address: still an IP.
    expect(scrubText('1.2.3.4 retries')).toBe('[ip] retries');
    expect(scrubText('from 203.0.113.9:443, ::ffff:198.51.100.7 and 2001:db8::1')).toBe(
      'from [ip]:443, ::ffff:[ip] and [ip]'
    );
    expect(scrubText('2001:0db8:85a3:0000:0000:8a2e:0370:7334 down')).toBe('[ip] down');
  });

  it("keeps a browser's version in its User-Agent", () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const event = scrubBrowserEvent({ request: { headers: { 'User-Agent': ua } } });
    expect(event.request?.headers).toEqual({ 'User-Agent': ua });
    // The header is still text: an email in it goes.
    const odd = scrubBrowserEvent({ request: { headers: { 'User-Agent': 'bot jane@x.edu' } } });
    expect(odd.request?.headers).toEqual({ 'User-Agent': 'bot [email]' });
  });

  it('redacts the real key shapes only', () => {
    expect(scrubText('key sk-ant-api03-abcDEF_123-xyz')).toBe('key [api-key]');
    expect(scrubText('key sk-proj-abcdefghijklmnop')).toBe('key [api-key]');
    expect(scrubText('key re_123abc45_ABCDEFGHIJKLMNOPQRSTUVWX x')).toBe('key [api-key] x');
  });

  it('redacts quoted header values and keeps prose names that are not secrets', () => {
    expect(
      scrubText("headers: { cookie: 'session=abc', authorization: 'x', 'x-api-key': \"abc\" }")
    ).toBe("headers: { cookie: [redacted], authorization: [redacted], 'x-api-key': [redacted] }");
    expect(scrubText('{ "x-api-key": "abc" }')).toBe('{ "x-api-key": [redacted] }');
    expect(scrubText('ENCRYPTION_KEY=0123456789abcdef0123456789abcdef DEPLOY_KEY: x')).toBe(
      'ENCRYPTION_KEY=[redacted] DEPLOY_KEY: x'
    );
    for (const text of [
      'cache key: c/cls_1/media/abc.png',
      'query: "SELECT 1 FROM users WHERE id = $1"',
      'body: "{\\"id\\":1}" session: expired_session_value header: content-type',
    ]) {
      expect(scrubText(text)).toBe(text);
    }
    // A Prisma invocation dump: the email and the token go, the shape stays.
    expect(
      scrubText(
        'Invalid `prisma.user.findFirst()` invocation:\n{\n  where: {\n    email: "jane@school.edu",\n    token: "t0k3n",\n    id: "u1"\n  }\n}'
      )
    ).toBe(
      'Invalid `prisma.user.findFirst()` invocation:\n{\n  where: {\n    email: "[email]",\n    token: [redacted],\n    id: "u1"\n  }\n}'
    );
  });

  it('keeps diagnostic keys and drops secret ones', () => {
    for (const key of [
      'code',
      'status_code',
      'error_code',
      'tokenCount',
      'tokens_per_hour',
      'filter_key',
      'signatureVersion',
      'cookieConsent',
      'tokenizer',
      'classroom_id',
      'http.response.status_code',
      'tokens',
      'input_tokens',
      'max_tokens',
      'total_tokens',
      'keys',
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
    for (const key of [
      'joinCode',
      'join_code',
      'shareCode',
      'invite',
      'accessToken',
      'api_key',
      'x-api-key',
      'apikey',
      'privateKey',
      'client_secret',
      'DB_PASS',
      'password_hash',
      'sessionId',
      'x-hub-signature-256',
      'set-cookie',
      'Proxy-Authorization',
      'url.query',
      'headers',
      'credentials',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON.parse messages
// ---------------------------------------------------------------------------

describe("V8's JSON.parse messages", () => {
  const MARKER = 'Jq7MARKERzW';
  const samples: unknown[] = [
    `${MARKER} Doe, hello`,
    `{"name":"${MARKER}" "x":1}`,
    `{"name":"${MARKER}`,
    '',
    undefined,
    `"${MARKER}`,
    MARKER,
    `{"a": tru${MARKER}}`,
    `{"a":1}${MARKER}`,
    `{"a":"\\q${MARKER}"}`,
    `{"a":"${MARKER}\u0001"}`,
    `{${MARKER}:1}`,
    `[1,2,${MARKER}]`,
    `${'x'.repeat(100)}${MARKER}${'y'.repeat(100)}`,
    `${'x'.repeat(5)}${MARKER}${'y'.repeat(100)}`,
    `${'x'.repeat(100)}${MARKER}`,
    `[${MARKER}`,
    `\n\n{"a" ${MARKER}}`,
    `<!DOCTYPE html><title>${MARKER}</title>`,
    `tr${MARKER}`,
    `'${MARKER}'`,
    `x"${MARKER}"y`,
    { toString: () => `${MARKER} object` },
  ];
  const messages = samples.flatMap(sample => {
    try {
      JSON.parse(sample as string);
      return [];
    } catch (error) {
      return [(error as Error).message];
    }
  });

  it('were generated by the real JSON.parse', () => {
    expect(messages).toHaveLength(samples.length);
    expect(messages.some(m => m.includes(MARKER.slice(0, 6)))).toBe(true);
  });

  it.each(messages)('never keep the input: %j', message => {
    const out = scrubText(`SyntaxError: ${message}`);
    // No piece of the marker survives (V8 quotes up to ten characters around the token).
    for (let i = 0; i + 3 <= MARKER.length; i++) expect(out).not.toContain(MARKER.slice(i, i + 3));
    // The error kind and the position stay.
    if (message.includes(' is not valid JSON')) {
      expect(out).toMatch(/"\[input\]" is not valid JSON$/);
    } else {
      expect(out).toBe(`SyntaxError: ${message}`);
    }
  });

  it('keeps the token and the kind of error', () => {
    expect(scrubText(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)).toBe(
      `Unexpected token '<', "[input]" is not valid JSON`
    );
    expect(scrubText('"undefined" is not valid JSON')).toBe('"[input]" is not valid JSON');
    expect(scrubText('Unexpected end of JSON input')).toBe('Unexpected end of JSON input');
  });
});

// ---------------------------------------------------------------------------
// SENSITIVE_PATHS against the real routes
// ---------------------------------------------------------------------------

const APPS = ['webapp', 'pages', 'slides', 'admin'];

type RouteSegment = { text: string; param?: string };

/** A flat-routes file or folder name as URL segments (layouts and index routes have none). */
const routeSegments = (name: string): RouteSegment[] => {
  const pieces: string[] = [];
  let current = '';
  let inBrackets = false;
  for (const char of name) {
    if (char === '[') inBrackets = true;
    else if (char === ']') inBrackets = false;
    else if (char === '.' && !inBrackets) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  pieces.push(current);
  return pieces.flatMap((piece): RouteSegment[] => {
    if (piece.startsWith('_') || piece.startsWith('(')) return [];
    const unescaped = piece.replace(/_$/, '').replace(/\[([^\]]*)\]/g, '$1');
    if (unescaped.startsWith('$')) {
      const param = /^\$(\w*)/.exec(unescaped)?.[1] || '*';
      return [{ text: `jane-doe${unescaped.slice(param === '*' ? 1 : param.length + 1)}`, param }];
    }
    return [{ text: unescaped }];
  });
};

const routeNames = (app: string): string[] =>
  readdirSync(new URL(`../../../../apps/${app}/app/routes`, import.meta.url))
    .filter(name => name !== '__tests__' && !name.startsWith('.'))
    .map(name => name.replace(/\.(tsx?|jsx?)$/, ''));

describe('SENSITIVE_PATHS against every app route', () => {
  const rewritten: string[] = [];
  // The routes registered by hand in apps/pages/app/routes.ts (and webapp's
  // auth catch-all), written as flat-route names.
  const manual = [
    'api.auth.$',
    '_render.page.$pageId',
    '$classroomSlug.forms',
    '$classroomSlug.forms.new',
    '$classroomSlug.forms.$formSlug',
    '$classroomSlug.forms.$formSlug.delivery',
    '$classroomSlug.forms.$formSlug.edit',
    '$classroomSlug.forms.$formSlug.responses.export',
    '$classroomSlug.forms.$formSlug.teams.$setSlug.status',
    '$classroomSlug.forms.$formSlug.verify',
    '$classroomSlug.forms.$formSlug.runs.$runNumber.compare.$otherNumber',
    '$pageSlug.schedule',
    '$pageSlug.sign-in',
    'robots[.txt]',
  ].map(name => ({ app: 'manual', name: name.replace(/^_render/, 'render') }));
  const routes = [...APPS.flatMap(app => routeNames(app).map(name => ({ app, name }))), ...manual];

  it('found the route files', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('rewrites no static segment of any route', () => {
    for (const { app, name } of routes) {
      const segments = routeSegments(name);
      if (segments.length === 0) continue;
      const path = `/${segments.map(s => s.text).join('/')}`;
      const out = scrubUrl(path).split('/').slice(1);
      segments.forEach((segment, i) => {
        if (segment.param) {
          if (out[i] !== segment.text) rewritten.push(`${app} ${name} :${segment.param}`);
        } else {
          expect(out[i], `${app} ${name}: ${path} → ${out.join('/')}`).toBe(segment.text);
        }
      });
    }
  });

  it('rewrites exactly the params that name a person or carry a credential', () => {
    expect(rewritten.sort()).toEqual(
      [
        'admin _shell.people_.$id :id',
        'webapp admin.$class.repos_.$title :title',
        'webapp admin.$class.repos_.$title.assign-graders :title',
        'webapp admin.$class.repos_.$title.contributions-csv :title',
        'webapp admin.$class.repos_.$title.update :title',
        'webapp admin.$class.staff.$login :login',
        'webapp admin.$class.students_.$login :login',
        'webapp admin.$class.teams.$slug.edit :slug',
        'webapp api.calendar.$slug.$signature[.ics] :signature',
        // `**/projects/[project]` (Gitlab paths) also takes this classroom slug.
        'webapp api.github.projects.$class :class',
        'webapp assistant.$class_.repos_.$title :title',
        'webapp join.$code :code',
        'webapp student.$class.repos_.$repo.team :repo',
        'webapp teacher.$class_.students_.$login :login',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Provider URLs inside error messages
// ---------------------------------------------------------------------------

describe('logins in Github URLs that Octokit errors quote', () => {
  it.each([
    ['https://api.github.com/users/jane-doe', 'https://api.github.com/users/[login]'],
    [
      'https://api.github.com/orgs/cs52-org/memberships/jane-doe',
      'https://api.github.com/orgs/cs52-org/memberships/[login]',
    ],
    [
      'https://api.github.com/orgs/cs52-org/members/jane-doe',
      'https://api.github.com/orgs/cs52-org/members/[login]',
    ],
    [
      'https://api.github.com/repos/cs52-org/hw1-jane-doe/collaborators/jane-doe/permission',
      'https://api.github.com/repos/cs52-org/[repo]/collaborators/[login]/permission',
    ],
    [
      'https://api.github.com/orgs/cs52-org/teams/jane-and-joe/memberships/jane-doe',
      'https://api.github.com/orgs/cs52-org/teams/[team]/memberships/[login]',
    ],
    ['https://github.com/jane-doe.png?size=40', 'https://github.com/[login].png'],
    // A profile page is left as it is; only the avatar form is rewritten.
    ['https://github.com/jane-doe', 'https://github.com/jane-doe'],
    [
      'https://api.github.com/user/memberships/orgs/cs52-org',
      'https://api.github.com/user/memberships/orgs/cs52-org',
    ],
  ])('%s', (url, expected) => expect(scrubUrl(url)).toBe(expected));

  it('also inside free text, with or without the host', () => {
    expect(
      scrubText('HttpError: Not Found - GET https://api.github.com/users/jane-doe failed')
    ).toBe('HttpError: Not Found - GET https://api.github.com/users/[login] failed');
    expect(scrubText('failed: PUT /orgs/cs52-org/teams/t1/memberships/jane-doe (404)')).toBe(
      'failed: PUT /orgs/cs52-org/teams/[team]/memberships/[login] (404)'
    );
  });
});
