/**
 * The Sentry scrubbers, one set for browser and server events: what an event,
 * a breadcrumb or a span may carry once it leaves the process. PURE and
 * isomorphic (types only from the SDK, no `process`, no Node built-ins, no
 * reporter), so the browser clients (`@classmoji/utils/sentry-scrub`) and the
 * servers (`./sentryServer.ts` re-exports all of it) share the same rules.
 *
 * See `./sentryServer.ts`'s header for the privacy rules they implement.
 */
import type { Breadcrumb } from '@sentry/core';

// ---------------------------------------------------------------------------
// Scrubbers
// ---------------------------------------------------------------------------

/**
 * Path segments that are a credential or name a person, the single table of
 * them. A path is matched segment by segment, each segment percent-decoded and
 * compared case-insensitively (React Router matches routes the same way, so
 * `/JOIN/abc` and `/%6Aoin/abc` reach the join route too); a segment that does
 * not decode is replaced by `[segment]`. Only the listed segments change, the
 * rest stays as it was sent. `scrubText` applies the same table to bare paths
 * inside free text. Query strings are dropped before these run, so only
 * PATH-borne values are listed (`?token=`, `?sig=`, `?shareCode=`, `?invite=`,
 * `?q=` and every other query value never get this far).
 *
 * Pattern syntax: `literal` or `(a|b)` must equal the segment, `:name` is any
 * segment kept as it is, `[name]` is any segment replaced by `[name]` (`?`
 * after it: only when present). A leading `**` matches at any depth. `hosts`
 * limits a rule to URLs on those hosts; `exceptHosts` keeps it off them.
 *
 * | Route                                                    | Value                       | Rewritten to                          |
 * | -------------------------------------------------------- | --------------------------- | ------------------------------------- |
 * | webapp `/join/:code`                                     | class invite code           | `/join/[code]`                        |
 * | webapp `/api/calendar/:slug/:signature.ics`              | calendar feed signature     | `/api/calendar/:slug/[signature]`     |
 * | better-auth `…/reset-password/:token`                    | password reset token        | `…/reset-password/[token]`            |
 * | content `/c/:id/theme/:theme/:tree/:p.v.exp.sig/…`       | signed policy segment       | `/c/:id/theme/:theme/:tree/[sig]/…`   |
 * | content `/c/:id/files/:grant/:p.v.exp.sig/…`             | grant + signed policy       | `/c/:id/files/[grant]/[sig]/…`        |
 * | webapp `/{admin,teacher,assistant}/:class/students/:login` | a student's git username  | `…/students/[login]`                  |
 * | webapp `/{admin,teacher,assistant}/:class/staff/:login`  | a staff member's username   | `…/staff/[login]`                     |
 * | webapp `/{admin,teacher,assistant,student}/:class/teams/:slug` | team slug (often names) | `…/teams/[team]`                     |
 * | webapp `…/repos/:repo` (student repos are named by login) | repository name            | `…/repos/[repo]`                      |
 * | Gitlab `…/projects/:project` (API and web)               | project path (by login)     | `…/projects/[project]`                |
 * | Github API `/repos/:owner/:repo`                         | repository name             | `/repos/:owner/[repo]`                |
 * | Github web `github.com/:owner/:repo`                     | repository name             | `/:owner/[repo]`                      |
 * | admin `/people/:id`                                      | another person's user id    | `/people/[id]`                        |
 *
 * Classroom slugs and page, slide, assignment and other record ids stay. After
 * these, the token patterns of `scrubText` (JWTs, `askmoji_…`, git and Stripe
 * keys, …) run over the path too, so a token in any other segment is still
 * redacted. A new route with a credential, a login, an email, a person's name
 * or another person's id in its PATH goes in this table.
 */
export const SENSITIVE_PATHS: ReadonlyArray<{
  name: string;
  pattern: string;
  hosts?: readonly string[];
  exceptHosts?: readonly string[];
}> = [
  { name: 'join link code', pattern: '/join/[code]' },
  { name: 'calendar feed signature', pattern: '/api/calendar/:slug/[signature]' },
  { name: 'password reset token', pattern: '**/reset-password/[token]' },
  { name: 'content theme signature', pattern: '/c/:id/theme/:theme/:tree/[sig]' },
  { name: 'content files grant and signature', pattern: '/c/:id/files/[grant]/[sig]?' },
  {
    name: 'student login',
    pattern: '/(admin|teacher|assistant)/:class/students/[login]',
  },
  { name: 'staff login', pattern: '/(admin|teacher|assistant)/:class/staff/[login]' },
  { name: 'team slug', pattern: '/(admin|teacher|assistant|student)/:class/teams/[team]' },
  { name: 'repository name', pattern: '**/repos/[repo]', exceptHosts: ['api.github.com'] },
  { name: 'Gitlab project path', pattern: '**/projects/[project]' },
  { name: 'Github API repository', pattern: '/repos/:owner/[repo]', hosts: ['api.github.com'] },
  { name: 'Github repository', pattern: '/:owner/[repo]', hosts: ['github.com'] },
  { name: 'person id (admin app)', pattern: '/people/[id]' },
];

type PathSegmentRule =
  | { kind: 'literal'; values: readonly string[] }
  | { kind: 'keep' }
  | { kind: 'redact'; label: string; optional: boolean };

type CompiledPathRule = {
  anyDepth: boolean;
  segments: PathSegmentRule[];
  hosts?: readonly string[];
  exceptHosts?: readonly string[];
};

const compilePathRule = (rule: (typeof SENSITIVE_PATHS)[number]): CompiledPathRule => {
  const anyDepth = rule.pattern.startsWith('**/');
  const body = anyDepth ? rule.pattern.slice(2) : rule.pattern;
  const segments = body
    .split('/')
    .slice(1)
    .map((piece): PathSegmentRule => {
      const redact = /^\[(\w+)\](\?)?$/.exec(piece);
      if (redact) return { kind: 'redact', label: redact[1], optional: Boolean(redact[2]) };
      if (piece.startsWith(':')) return { kind: 'keep' };
      const choice = /^\((.+)\)$/.exec(piece);
      return {
        kind: 'literal',
        values: (choice ? choice[1].split('|') : [piece]).map(v => v.toLowerCase()),
      };
    });
  return { anyDepth, segments, hosts: rule.hosts, exceptHosts: rule.exceptHosts };
};

const COMPILED_PATHS: readonly CompiledPathRule[] = SENSITIVE_PATHS.map(compilePathRule);

/** One segment percent-decoded and lower-cased for matching, or null when it does not decode. */
const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return null;
  }
};

/**
 * `path` (no query, no fragment) with every SENSITIVE_PATHS segment replaced.
 * `host` is the URL's host (lower case) when there is one.
 */
const rewriteSensitivePath = (path: string, host?: string): string => {
  const raw = path.split('/');
  const decoded = raw.map(decodeSegment);
  const out = raw.map((segment, i) => (decoded[i] === null ? '[segment]' : segment));
  // Index 0 is what precedes the first `/` (empty for a path).
  for (const rule of COMPILED_PATHS) {
    if (rule.hosts && !(host && rule.hosts.includes(host))) continue;
    if (rule.exceptHosts && host && rule.exceptHosts.includes(host)) continue;
    const lastStart = rule.anyDepth ? raw.length - 1 : 1;
    for (let start = 1; start <= lastStart; start++) {
      const redactAt: Array<[number, string]> = [];
      let matched = true;
      for (let j = 0; j < rule.segments.length; j++) {
        const seg = rule.segments[j];
        const at = start + j;
        if (at >= raw.length || raw[at] === '') {
          if (seg.kind === 'redact' && seg.optional) break;
          matched = false;
          break;
        }
        const value = decoded[at];
        if (value === null) {
          matched = false;
          break;
        }
        if (seg.kind === 'literal' && !seg.values.includes(value)) {
          matched = false;
          break;
        }
        if (seg.kind === 'redact') redactAt.push([at, `[${seg.label}]`]);
      }
      if (matched) for (const [at, label] of redactAt) out[at] = label;
    }
  }
  return out.join('/');
};

/**
 * Tokens and keys that may turn up in error messages, each with its stand-in.
 * Applied by `scrubText` (and so to every URL path too).
 */
const TOKEN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization header values quoted in a message.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // JWTs (access tokens, id tokens): three base64url parts, the first `eyJ`.
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt]'],
  // Classmoji's own MCP tokens.
  [/\baskmoji_[A-Za-z0-9_-]+/g, 'askmoji_[redacted]'],
  // Github tokens: personal, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  [/\bgh[pousr]_[A-Za-z0-9_]+/g, '[github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]+/g, '[github-token]'],
  // Gitlab tokens (personal, OAuth app secret, deploy, runner, trigger, feed, …).
  [
    /\bgl(?:pat|oas|dt|rt|ptt|ft|imt|agent|cbt|soat|ffct|wt|rtr|feat)-[A-Za-z0-9_-]+/g,
    '[gitlab-token]',
  ],
  // Stripe secret and restricted keys, webhook signing secrets (Stripe, Svix/Resend).
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[stripe-key]'],
  [/\bwhsec_[A-Za-z0-9+/=_-]+/g, '[webhook-secret]'],
  // Anthropic and OpenAI-style API keys.
  [/\bsk-ant-[A-Za-z0-9_-]+/g, '[api-key]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[api-key]'],
  // better-auth's session cookie values, if a message ever quotes a Cookie header.
  [/\b((?:__Secure-)?[\w.-]*session_(?:token|data))=[^;\s"'`]+/gi, '$1=[redacted]'],
  // Resend API keys, AWS access key ids.
  [/\bre_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{20,}/g, '[api-key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws-key]'],
  // Stripe (and Stripe-style) webhook signature values: `t=…,v1=…`.
  [/\bt=\d+(?:,v\d+=[0-9a-f]+)+/gi, '[signature]'],
  // Header lines whose name is a secret: `x-collab-secret: …`, `stripe-signature: …`,
  // `Cookie: …`.
  [
    /\b((?:x-[\w-]*(?:secret|token|key|signature|auth)[\w-]*)|[\w-]*-signature|cookie|set-cookie)(\s*:\s*)[^\r\n"'`]+/gi,
    '$1$2[redacted]',
  ],
  // Env-style pairs: `SOME_SECRET=…`, `*_KEY=…`, `*_TOKEN=…`, `*_PASSWORD=…` (also with `:`).
  [
    /\b([A-Z][A-Z0-9_]*_(?:SECRET|KEY|TOKEN|PASSWORD|PASS|PWD))(\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'`,;&]+)/g,
    '$1$2[redacted]',
  ],
  // `key: value` and JSON `"key":"value"` whose key names a secret.
  [
    /(["']?)\b((?:access_|refresh_|id_|session_|auth_)?token|password|passwd|secret|client_secret|api[_-]?key|apiSecret|authToken|sessionToken|accessToken|refreshToken|privateKey|private_key)\1(\s*:\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'`,;&}]+)/gi,
    '$1$2$1$3[redacted]',
  ],
  // key=value pairs whose key names a secret.
  [
    /\b((?:access_|refresh_|id_)?token|password|passwd|secret|client_secret|api[_-]?key|code|sig|signature|invite|shareCode|joinCode)=[^&\s"'`;,]+/gi,
    '$1=[redacted]',
  ],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

/** Private, loopback and link-local IPv4 ranges: infrastructure, kept for debugging. */
const isInternalIPv4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT, used by some platforms internally
  );
};

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
// Full (8-group) and `::`-compressed forms. Bare `a:b:c` (clock times) is left alone.
const IPV6 =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/gi;
/** fc00::/7 (Fly 6PN is fdaa:), fe80::/10, ::1 and :: stay. */
const isInternalIPv6 = (ip: string): boolean =>
  /^(?:f[cd]|fe[89ab])/i.test(ip) || /^::1?$/.test(ip);

const scrubIps = (text: string): string =>
  text
    .replace(IPV4, ip => (isInternalIPv4(ip) ? ip : '[ip]'))
    .replace(IPV6, ip => (isInternalIPv6(ip) ? ip : '[ip]'));

const scrubTokens = (text: string): string => {
  let out = text;
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  return out;
};

/** Rewrite a path (no query, no fragment) through SENSITIVE_PATHS, then token patterns. */
const scrubPath = (path: string, host?: string): string =>
  scrubIps(scrubTokens(rewriteSensitivePath(path, host)));

const SCHEME_AND_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is;

/**
 * A URL as it may be sent: no query string, no fragment, no `user:password@`,
 * credential path segments rewritten, tokens redacted. Accepts absolute URLs
 * (any scheme, so `postgres://user:pw@host/db` loses its password) and bare
 * paths. A `data:` URL keeps only its media type.
 */
export const scrubUrl = (url: string): string => {
  if (typeof url !== 'string' || !url) return url;
  const dataUrl = /^data:([^,;]*)/i.exec(url);
  if (dataUrl) return `data:${dataUrl[1]},[data]`;
  const cut = url.search(/[?#]/);
  const withoutQuery = cut === -1 ? url : url.slice(0, cut);
  const parts = SCHEME_AND_AUTHORITY.exec(withoutQuery);
  if (!parts) return scrubPath(withoutQuery);
  const [, scheme, authority, path] = parts;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return `${scheme}${scrubIps(host)}${scrubPath(path, hostname)}`;
};

/** Absolute URLs (any scheme) inside free text. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
/**
 * Bare paths inside free text (`No route matches URL "/join/abc?x=1"`): a `/`
 * at the start or after a quote, space, bracket, `=` or `:`, then path
 * characters and an optional query. Only the credential rules and the query
 * strip apply to these.
 */
const PATH_IN_TEXT = /(^|[\s"'`([<=:,])(\/[^\s"'`<>()[\]?#]*)(?:[?#][^\s"'`<>()[\]]*)?/g;

/**
 * Free text as it may be sent: URLs through `scrubUrl`, query strings cut
 * from bare paths, credential paths rewritten, tokens, keys, emails and
 * public IP addresses redacted.
 */
export const scrubText = (text: string): string => {
  if (typeof text !== 'string' || !text) return text;
  const placeholders: string[] = [];
  // URLs first, parked behind placeholders so the path pass does not see
  // their paths a second time.
  let out = text.replace(URL_IN_TEXT, match => {
    // Trailing sentence punctuation is not part of the URL.
    const trail = /[.,;:!)\]]+$/.exec(match)?.[0] ?? '';
    const url = trail ? match.slice(0, -trail.length) : match;
    placeholders.push(scrubUrl(url) + trail);
    return `\uE000${placeholders.length - 1}\uE001`;
  });
  out = out.replace(
    PATH_IN_TEXT,
    (_match, lead: string, path: string) => lead + rewriteSensitivePath(path)
  );
  out = scrubIps(scrubTokens(out));
  return out.replace(
    /\uE000(\d+)\uE001/g,
    (_m, index: string) => placeholders[Number(index)] ?? ''
  );
};

/**
 * Keys whose values are never sent, wherever they appear in `extra`,
 * `contexts` or breadcrumb data. A key is compared with `-`, `_`, `.` and
 * spaces removed, in lower case: dropped when it is one of SECRET_KEY_EXACT,
 * or contains one of SECRET_KEY_PARTS (so `authToken`, `session_token`,
 * `apiSecret`, `credentials`, `x-collab-secret` all go). `token` counts only
 * when not followed by `s` (`tokens_per_hour` is the extension price, not a
 * secret); `status_code`, `filter_key` and other diagnostics stay.
 */
const SECRET_KEY_EXACT = new Set([
  'header',
  'headers',
  'cookie',
  'cookies',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'body',
  'query',
  'querystring',
  'httpquery',
  'urlquery',
  'httpfragment',
  'urlfragment',
  'code',
  'sig',
  'jwt',
  'dsn',
]);
const SECRET_KEY_PARTS =
  /password|passwd|secret|token(?!s)|credential|jwt|apikey|privatekey|accesskey|signingkey|encryptionkey|signature|joincode|invitecode|sharecode|authcode|otpcode|sessionid|cookie/;

export const isSecretKey = (key: string): boolean => {
  const normalized = key.replace(/[-_.\s]/g, '').toLowerCase();
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_PARTS.test(normalized);
};

const MAX_DEPTH = 6;

/** Deep copy of a JSON-ish value with secret keys dropped and every string scrubbed. */
export const scrubValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) continue;
    out[key] =
      key === 'url' && typeof item === 'string' ? scrubUrl(item) : scrubValue(item, depth + 1);
  }
  return out;
};

/** `GET /join/abc` → `GET /join/[code]`; anything else through scrubText. */
export const scrubTransaction = (transaction: string): string => {
  const routed = /^([A-Z]+) (\S+)$/.exec(transaction);
  return routed ? `${routed[1]} ${scrubUrl(routed[2])}` : scrubText(transaction);
};

/**
 * A breadcrumb as it may be sent, or null to drop it. Console breadcrumbs
 * (log text) are dropped. Everything else has its message scrubbed and its
 * data rebuilt: URLs through `scrubUrl`, query/fragment/header keys dropped,
 * strings through `scrubText`.
 */
export const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  if (!breadcrumb) return null;
  if (breadcrumb.category === 'console') return null;
  const out: Breadcrumb = { ...breadcrumb };
  if (typeof out.message === 'string') out.message = scrubText(out.message);
  if (out.data && typeof out.data === 'object') {
    const data = scrubValue(out.data) as Record<string, unknown>;
    for (const key of ['from', 'to']) {
      if (typeof data[key] === 'string') data[key] = scrubUrl(data[key] as string);
    }
    out.data = data;
  }
  return out;
};

/**
 * Event shape `scrubEvent` reads. Structural, so it accepts `ErrorEvent` from
 * either SDK and plain objects in tests.
 */
type ScrubbableEvent = {
  message?: string;
  transaction?: string;
  logentry?: { message?: string; params?: unknown[] };
  request?: { method?: string; url?: string; headers?: Record<string, unknown> };
  user?: { id?: string | number };
  fingerprint?: string[];
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { data?: Record<string, unknown> };
      stacktrace?: { frames?: Array<{ vars?: unknown }> };
    }>;
  };
  breadcrumbs?: Breadcrumb[];
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
};

/** The listed headers (case-insensitive), URL-valued ones scrubbed; undefined when none is left. */
const keepHeaders = (
  headers: Record<string, unknown> | undefined,
  allow: readonly string[]
): Record<string, string> | undefined => {
  if (!headers || typeof headers !== 'object' || allow.length === 0) return undefined;
  const wanted = allow.map(name => name.toLowerCase());
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !wanted.includes(name.toLowerCase())) continue;
    out[name] = /^referr?er$/i.test(name) ? scrubUrl(value) : scrubText(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Contexts that describe the visitor or where they are, never sent. On a
 * Worker `@sentry/cloudflare` sets `culture.timezone` from `request.cf` (the
 * visitor's time zone); on Node `culture` is the server's locale, not needed.
 * `geo` and `cf` are not set by the SDK today; dropped in case a later
 * version or an integration copies location data from `request.cf` there.
 */
const VISITOR_CONTEXTS = ['culture', 'geo', 'cf'] as const;

/**
 * An event as it may be sent (mutated in place and returned, as `beforeSend`
 * allows):
 * - `request` → `{ method, url }`, the URL through `scrubUrl` (no headers,
 *   cookies, body, query string or env);
 * - `user` → `{ id }` (no email, username or IP), or removed;
 * - `transaction`, `message`, `logentry`, `fingerprint`, exception types,
 *   messages and `mechanism.data` → scrubbed;
 * - stack frames lose `vars` (local variables);
 * - `breadcrumbs` → `scrubBreadcrumb` (console ones dropped);
 * - `contexts.culture`, `.geo`, `.cf` (the visitor's time zone or location)
 *   → removed;
 * - `tags`, `extra`, `contexts` → secret keys dropped, strings scrubbed;
 *   `extra.__serialized__` (the contents of a non-Error value captured as an
 *   exception) is dropped.
 * `server_name` is kept on purpose (an opaque Fly machine id).
 */
export const scrubEvent = <E extends ScrubbableEvent>(
  event: E,
  options: { keepRequestHeaders?: readonly string[] } = {}
): E => {
  if (!event || typeof event !== 'object') return event;

  if (event.request) {
    const { method, url, headers } = event.request;
    const request: { method?: string; url?: string; headers?: Record<string, string> } = {};
    if (typeof method === 'string') request.method = method;
    if (typeof url === 'string') request.url = scrubUrl(url);
    // Only the browser's own description of itself (Sentry reads the browser
    // and OS from it) and the page it came from, scrubbed; on a server
    // nothing is listed, so no header survives.
    const kept = keepHeaders(headers, options.keepRequestHeaders ?? []);
    if (kept) request.headers = kept;
    event.request = request as E['request'];
  }

  if (event.user) {
    const id = event.user.id;
    if (typeof id === 'string' || typeof id === 'number') {
      event.user = { id } as E['user'];
    } else {
      delete event.user;
    }
  }

  if (typeof event.transaction === 'string')
    event.transaction = scrubTransaction(event.transaction);
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === 'string') {
      event.logentry.message = scrubText(event.logentry.message);
    }
    if (Array.isArray(event.logentry.params)) {
      event.logentry.params = event.logentry.params.map(param => scrubValue(param));
    }
  }

  if (Array.isArray(event.fingerprint)) {
    event.fingerprint = event.fingerprint.map(part =>
      typeof part === 'string' ? scrubText(part) : part
    );
  }

  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.type === 'string') exception.type = scrubText(exception.type);
    if (typeof exception.value === 'string') exception.value = scrubText(exception.value);
    if (exception.mechanism?.data && typeof exception.mechanism.data === 'object') {
      exception.mechanism.data = scrubValue(exception.mechanism.data) as Record<string, unknown>;
    }
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map(breadcrumb => scrubBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }

  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === 'string') event.tags[key] = scrubText(value);
    }
  }
  if (event.extra) {
    // A non-Error value captured as an exception (a rejected plain object,
    // by the SDK's own process or Express handlers) arrives as
    // `extra.__serialized__`: its whole contents. Never sent; the event's
    // message already names its keys.
    delete event.extra.__serialized__;
    event.extra = scrubValue(event.extra) as E['extra'];
  }
  if (event.contexts) {
    for (const key of VISITOR_CONTEXTS) delete event.contexts[key];
    event.contexts = scrubValue(event.contexts) as E['contexts'];
  }

  return event;
};

// ---------------------------------------------------------------------------
// Browser (the webapp, pages, slides and admin clients)
// ---------------------------------------------------------------------------

/** The headers a browser event keeps: Sentry reads the browser and OS from the first. */
export const BROWSER_REQUEST_HEADERS: readonly string[] = ['User-Agent', 'Referer'];

/** A browser event as it may be sent: `scrubEvent`, keeping only BROWSER_REQUEST_HEADERS. */
export const scrubBrowserEvent = <E extends ScrubbableEvent>(event: E): E =>
  scrubEvent(event, { keepRequestHeaders: BROWSER_REQUEST_HEADERS });

/**
 * Attribute values in the element path a click or input breadcrumb names
 * (`button.save[title="Jane Doe"][aria-label="…"]`, as the SDK's
 * `htmlTreeAsString` writes `aria-label`, `type`, `name`, `title`, `alt` and
 * any key attribute): the values can be a person's name or text a user typed,
 * so only the attribute names stay (`[title]`).
 */
const ELEMENT_ATTRIBUTE = /\[([\w:-]+)="[\s\S]*?"\](?=\[|\s>\s|$)/g;

/** `[title="…"]` → `[title]` throughout an element path. */
export const stripElementAttributes = (path: string): string =>
  path.replace(ELEMENT_ATTRIBUTE, '[$1]');

/**
 * A browser breadcrumb as it may be sent: `scrubBreadcrumb`, and for
 * `ui.click` / `ui.input` (and any other `ui.*`) the element path loses its
 * attribute values.
 */
export const scrubBrowserBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  const out = scrubBreadcrumb(breadcrumb);
  if (out && typeof out.category === 'string' && out.category.startsWith('ui.')) {
    if (typeof out.message === 'string') out.message = stripElementAttributes(out.message);
  }
  return out;
};

/** Span attributes never sent (query strings, fragments, who the user is beyond the id). */
const DROPPED_SPAN_ATTRIBUTES = new Set([
  'url.query',
  'http.query',
  'url.fragment',
  'http.fragment',
  'user.email',
  'user.ip_address',
  'user.name',
  'user.username',
  'client.address',
]);

/** One span attribute value as it may be sent, or undefined to drop it. */
const scrubSpanAttribute = (key: string, value: unknown): unknown => {
  if (DROPPED_SPAN_ATTRIBUTES.has(key) || isSecretKey(key)) return undefined;
  const scrubString = (text: string) =>
    /url|uri|referr?er|\bpath\b|\.path$|route|segment\.name/i.test(key)
      ? /^[A-Z]+ \S+$/.test(text)
        ? scrubTransaction(text)
        : scrubUrl(text)
      : scrubText(text);
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value))
    return value.map(item => (typeof item === 'string' ? scrubString(item) : item));
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    const scrubbed = scrubSpanAttribute(key, inner);
    return scrubbed === undefined ? undefined : { ...value, value: scrubbed };
  }
  return value;
};

/**
 * `beforeSendSpan` for the browser's sampled traces (Sentry 11 streams spans
 * one by one, and `beforeSendTransaction` is never called then): the span's
 * name (`GET /api/search?q=…`, a page URL) and its attributes (`url.full`,
 * `http.url`, `sentry.segment.name`, …) go through the same rules as events;
 * query, fragment and user attributes beyond `user.id` are dropped. Mutates
 * and returns the span, as the SDK allows.
 */
export const scrubSpan = <S extends { name?: string; attributes?: Record<string, unknown> }>(
  span: S
): S => {
  if (!span || typeof span !== 'object') return span;
  if (typeof span.name === 'string') span.name = scrubTransaction(span.name);
  if (span.attributes && typeof span.attributes === 'object') {
    for (const [key, value] of Object.entries(span.attributes)) {
      const scrubbed = scrubSpanAttribute(key, value);
      if (scrubbed === undefined) delete span.attributes[key];
      else span.attributes[key] = scrubbed;
    }
  }
  return span;
};
