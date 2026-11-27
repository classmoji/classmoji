/**
 * Server-side error tracking (Sentry): the options and scrubbers every server
 * surface shares, for the Fly Node servers (`@sentry/node`, through
 * `initServerSentry` in `@classmoji/utils/sentry-node`) and the Cloudflare
 * Workers (`@sentry/cloudflare`, through `withSentry`).
 *
 * PURE and isomorphic: no SDK import (types only), no `process`, no Node
 * built-ins. The env is passed in, so a Worker hands its `env` binding object
 * and Node hands `process.env`.
 *
 * Errors only: no tracing, no spans, no trace headers on outgoing requests,
 * no sessions, no breadcrumbs of log text.
 *
 * PRIVACY (the main risk). No event may carry cookies, `Authorization` or any
 * other header, request or response bodies, query strings, IP addresses, user
 * details beyond the internal user id, or local variables. Three layers:
 *   1. `dataCollection` tells the SDK not to collect them at all.
 *   2. `beforeSend` (`scrubEvent`) rebuilds `event.request` as method + scrubbed
 *      URL, reduces `user` to `{ id }`, and runs every free-text string
 *      (exception messages, message, transaction, tags, extra, contexts,
 *      breadcrumbs) through `scrubText`.
 *   3. `beforeBreadcrumb` (`scrubBreadcrumb`) drops console breadcrumbs and
 *      scrubs URLs on the rest.
 * URL paths that carry a credential are rewritten (see CREDENTIAL_PATHS below).
 * `server_name` (the Fly machine's hostname, an opaque id) is kept: it is not a
 * secret and tells which machine failed.
 *
 * Usage, Node (Fly): `initServerSentry('webapp')` from `@classmoji/utils/sentry-node`.
 *
 * Usage, Worker (`@sentry/cloudflare` 11):
 *
 *   import * as Sentry from '@sentry/cloudflare';
 *   export default Sentry.withSentry(
 *     (env: Env): Sentry.CloudflareOptions => {
 *       const options = sentryServerOptions(env, { app: 'content', runtime: 'worker' });
 *       return options
 *         ? { ...options, integrations: workerIntegrations(Sentry) }
 *         : sentryOffOptions();
 *     },
 *     handler
 *   );
 *   // and once, at module scope, so reportError() from shared code reaches it:
 *   setErrorReporter(createSentryReporter(Sentry));
 *
 * The reporter only calls the SDK when something is reported; with Sentry off
 * the SDK has no client and drops it.
 *
 * Annotate the callback's return type (`Sentry.CloudflareOptions`): withSentry
 * infers its options type from the callback, and the on/off union otherwise
 * fails its exact-keys check (pinned by sentryServer.sdkTypes.test.ts).
 * Never return `undefined` from that callback: `withSentry` then reads
 * `SENTRY_DSN` from the env itself and starts with the SDK's defaults (which
 * collect everything). `sentryOffOptions()` has an empty DSN and `enabled: false`.
 * Set `SENTRY_ENVIRONMENT` as a Worker var (Workers have no `FLY_APP_NAME`),
 * or pass `environment` explicitly. Never set `SENTRY_TRACES_SAMPLE_RATE`:
 * both SDKs read it from the env when `tracesSampleRate` is unset, which
 * would turn tracing on. (No `beforeSendTransaction` guard: with Sentry 11's
 * default streamed spans the SDK ignores it and prints a warning at init.)
 */
import type { Breadcrumb, DataCollection, ErrorEvent, EventHint } from '@sentry/core';
import type { ErrorReporter, ReportContext } from './errorReport.ts';
import { sentryEnvironment } from './sentry.ts';

export type ServerApp =
  | 'webapp'
  | 'pages'
  | 'slides'
  | 'admin'
  | 'mcp'
  | 'collab'
  | 'hook-station'
  | 'content';

/** `server` = a Node process on Fly; `worker` = a Cloudflare Worker. */
export type ServerRuntime = 'server' | 'worker';

/** Options common to `@sentry/node`'s `init` and `@sentry/cloudflare`'s `withSentry`. */
export interface SentryServerOptions {
  dsn: string;
  environment: string;
  dataCollection: DataCollection;
  tracePropagationTargets: string[];
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  beforeBreadcrumb: (breadcrumb: Breadcrumb) => Breadcrumb | null;
  initialScope: { tags: { app: ServerApp; runtime: ServerRuntime } };
}

/**
 * What a Worker's `withSentry` callback returns when Sentry is off: an empty
 * DSN (so the SDK does not fall back to `env.SENTRY_DSN`) and `enabled: false`.
 */
export const sentryOffOptions = (): { dsn: string; enabled: false } => ({
  dsn: '',
  enabled: false,
});

/**
 * Everything Sentry 11 can collect, turned off. (The browser keeps a little
 * more; servers need none of it.) A fresh object per call, since SDKs may
 * normalise options in place.
 */
export const serverDataCollection = (): DataCollection => ({
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

/**
 * Any env object: `process.env`, or a Worker's `env` (whose bindings are not
 * strings). Only string values are read; anything else counts as unset.
 */
const readEnv = (env: object, key: string): string => {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * The server's Sentry environment: an explicit `SENTRY_ENVIRONMENT` wins (how
 * a Worker says which it is), else the Fly app name (`sentryEnvironment`:
 * `…-staging` → staging, `…-dev` → dev, any other Fly app → production, no
 * Fly app → development).
 */
export const sentryServerEnvironment = (env: object): string =>
  readEnv(env, 'SENTRY_ENVIRONMENT') ||
  sentryEnvironment(readEnv(env, 'FLY_APP_NAME') || undefined);

/**
 * Sentry options for one server surface, or null when `SENTRY_DSN` is unset or
 * blank (Sentry stays off: nothing registered, nothing sent, no output).
 * `env` is `process.env` or a Worker's `env` object, typed `object` so a
 * Worker's `Env` interface (with its R2/KV bindings) passes as it is.
 *
 * Spread the result into the SDK's options and add only the SDK-specific bits
 * (integrations; on Node `enableRuntimeChannelInjection: false`).
 */
export const sentryServerOptions = (
  env: object,
  opts: { app: ServerApp; runtime: ServerRuntime; environment?: string }
): SentryServerOptions | null => {
  const dsn = readEnv(env, 'SENTRY_DSN');
  if (!dsn) return null;
  return {
    dsn,
    environment: opts.environment?.trim() || sentryServerEnvironment(env),
    dataCollection: serverDataCollection(),
    // No outgoing request ever carries sentry-trace/baggage/traceparent.
    tracePropagationTargets: [],
    beforeSend: event => scrubEvent(event),
    beforeBreadcrumb: breadcrumb => scrubBreadcrumb(breadcrumb),
    initialScope: { tags: { app: opts.app, runtime: opts.runtime } },
  };
};

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

type NamedIntegration = { name: string };

/**
 * Default integrations a Worker must not run as they come: Console (log text
 * as breadcrumbs), Fetch (breadcrumbs of every outgoing URL) and HttpServer
 * (request bodies); the last two are re-added retuned by `workerIntegrations`.
 */
export const WORKER_REPLACED_INTEGRATIONS: readonly string[] = ['Console', 'Fetch', 'HttpServer'];

/**
 * The `integrations` option for `@sentry/cloudflare`: its defaults minus
 * Console, with Fetch re-added without breadcrumbs and HttpServer without
 * bodies or spans (it still gives each request its own scope and the
 * method + URL that `scrubEvent` rewrites). Pass the SDK namespace (or just
 * its two factories) so this module never imports the SDK itself.
 */
export const workerIntegrations =
  <I extends NamedIntegration>(sdk: {
    fetchIntegration: (options: { breadcrumbs: false }) => I;
    httpServerIntegration: (options: { maxRequestBodySize: 'none'; spans: false }) => I;
  }) =>
  (defaults: I[]): I[] => [
    ...defaults.filter(integration => !WORKER_REPLACED_INTEGRATIONS.includes(integration.name)),
    sdk.fetchIntegration({ breadcrumbs: false }),
    sdk.httpServerIntegration({ maxRequestBodySize: 'none', spans: false }),
  ];

// ---------------------------------------------------------------------------
// Scrubbers
// ---------------------------------------------------------------------------

/**
 * Path segments that are credentials, the single table of them. Each `match`
 * is anchored at the start of a path (`/…`); `scrubText` also applies it to
 * bare paths inside free text. Query strings are dropped before these run, so
 * only PATH-borne secrets are listed (`?token=`, `?sig=`, `?shareCode=`,
 * `?invite=`, `?code=` and every other query value never get this far).
 *
 * | Route                                               | Secret                     | Rewritten to                               |
 * | --------------------------------------------------- | -------------------------- | ------------------------------------------ |
 * | webapp `/join/:code`                                | class invite code          | `/join/[code]`                             |
 * | webapp `/api/calendar/:slug/:signature.ics`         | calendar feed signature    | `/api/calendar/:slug/[signature]`          |
 * | better-auth `…/reset-password/:token`               | password reset token       | `…/reset-password/[token]`                 |
 * | content `/c/:id/theme/:theme/:tree/:p.v.exp.sig/…`  | signed policy segment      | `/c/:id/theme/:theme/:tree/[sig]/…`        |
 * | content `/c/:id/files/:grant/:p.v.exp.sig/…`        | grant + signed policy      | `/c/:id/files/[grant]/[sig]/…`             |
 *
 * After these, the token patterns of `scrubText` (JWTs, `askmoji_…`, git and
 * Stripe keys, …) run over the path too, so a token in any other segment is
 * still redacted.
 */
export const CREDENTIAL_PATHS: ReadonlyArray<{
  name: string;
  match: RegExp;
  replace: string;
}> = [
  { name: 'join link code', match: /^\/join\/[^/?#\s"'`<>]+/, replace: '/join/[code]' },
  {
    name: 'calendar feed signature',
    match: /^\/api\/calendar\/([^/?#\s"'`<>]+)\/[^/?#\s"'`<>]+/,
    replace: '/api/calendar/$1/[signature]',
  },
  {
    name: 'password reset token',
    match: /^((?:\/[^/?#\s"'`<>]+)*?)\/reset-password\/[^/?#\s"'`<>]+/,
    replace: '$1/reset-password/[token]',
  },
  {
    name: 'content theme signature',
    match: /^\/c\/([^/?#\s"'`<>]+)\/theme\/([^/?#\s"'`<>]+)\/([^/?#\s"'`<>]+)\/[^/?#\s"'`<>]+/,
    replace: '/c/$1/theme/$2/$3/[sig]',
  },
  {
    name: 'content files grant and signature',
    match: /^\/c\/([^/?#\s"'`<>]+)\/files\/[^/?#\s"'`<>]+(?:\/[^/?#\s"'`<>]+)?/,
    replace: '/c/$1/files/[grant]/[sig]',
  },
];

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
  // key=value pairs whose key names a secret.
  [
    /\b((?:access_|refresh_|id_)?token|password|passwd|secret|client_secret|api[_-]?key|code|sig|signature|invite|shareCode)=[^&\s"'`;,]+/gi,
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

/** Rewrite a path (no query, no fragment) through CREDENTIAL_PATHS, then token patterns. */
const scrubPath = (path: string): string => {
  let out = path;
  for (const rule of CREDENTIAL_PATHS) out = out.replace(rule.match, rule.replace);
  return scrubIps(scrubTokens(out));
};

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
  return `${scheme}${scrubIps(host)}${scrubPath(path)}`;
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
  out = out.replace(PATH_IN_TEXT, (_match, lead: string, path: string) => {
    let scrubbed = path;
    for (const rule of CREDENTIAL_PATHS) scrubbed = scrubbed.replace(rule.match, rule.replace);
    return lead + scrubbed;
  });
  out = scrubIps(scrubTokens(out));
  return out.replace(
    /\uE000(\d+)\uE001/g,
    (_m, index: string) => placeholders[Number(index)] ?? ''
  );
};

/** Keys whose values are never sent, wherever they appear in `extra`/`contexts`/breadcrumb data. */
const SECRET_KEYS =
  /^(?:headers?|cookies?|set-cookie|authorization|proxy-authorization|x-collab-secret|body|query|query_string|password|secret|token|access_token|refresh_token|api_key|apikey|http\.query|url\.query|http\.fragment|url\.fragment)$/i;

const MAX_DEPTH = 6;

/** Deep copy of a JSON-ish value with secret keys dropped and every string scrubbed. */
const scrubValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) continue;
    out[key] =
      key === 'url' && typeof item === 'string' ? scrubUrl(item) : scrubValue(item, depth + 1);
  }
  return out;
};

/** `GET /join/abc` → `GET /join/[code]`; anything else through scrubText. */
const scrubTransaction = (transaction: string): string => {
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
  request?: { method?: string; url?: string };
  user?: { id?: string | number };
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: { frames?: Array<{ vars?: unknown }> };
    }>;
  };
  breadcrumbs?: Breadcrumb[];
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
};

/**
 * An event as it may be sent (mutated in place and returned, as `beforeSend`
 * allows):
 * - `request` → `{ method, url }`, the URL through `scrubUrl` (no headers,
 *   cookies, body, query string or env);
 * - `user` → `{ id }` (no email, username or IP), or removed;
 * - `transaction`, `message`, `logentry`, exception messages → scrubbed;
 * - stack frames lose `vars` (local variables);
 * - `breadcrumbs` → `scrubBreadcrumb` (console ones dropped);
 * - `tags`, `extra`, `contexts` → secret keys dropped, strings scrubbed;
 *   `extra.__serialized__` (the contents of a non-Error value captured as an
 *   exception) is dropped.
 * `server_name` is kept on purpose (an opaque Fly machine id).
 */
export const scrubEvent = <E extends ScrubbableEvent>(event: E): E => {
  if (!event || typeof event !== 'object') return event;

  if (event.request) {
    const { method, url } = event.request;
    const request: { method?: string; url?: string } = {};
    if (typeof method === 'string') request.method = method;
    if (typeof url === 'string') request.url = scrubUrl(url);
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

  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = scrubText(exception.value);
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
  if (event.contexts) event.contexts = scrubValue(event.contexts) as E['contexts'];

  return event;
};

// ---------------------------------------------------------------------------
// Reporter (what `reportError` hands errors to)
// ---------------------------------------------------------------------------

/** The part of a Sentry scope the reporter writes. Both SDKs' `Scope` satisfy it. */
type ScopeLike = {
  setTag(key: string, value: string | number | boolean): unknown;
  setLevel(level: 'fatal' | 'error' | 'warning'): unknown;
  setExtras(extras: Record<string, unknown>): unknown;
};

/** The SDK functions the reporter needs; pass `@sentry/node` or `@sentry/cloudflare` itself. */
export type SentryReporterSdk = {
  withScope: (callback: (scope: ScopeLike) => void) => void;
  captureException: (
    exception: unknown,
    hint?: { mechanism?: { type: string; handled: boolean } }
  ) => unknown;
  flush: (timeout?: number) => PromiseLike<boolean>;
};

/**
 * What is actually sent for a reported value. An Error is itself. A thrown
 * 5xx `Response` or a route error response becomes an Error naming its status
 * (or the Error a route error response carries). A string becomes an Error
 * with that message (scrubbed by `beforeSend`). Anything else becomes an Error
 * naming only its type, never its contents.
 */
export const toReportableError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (typeof Response !== 'undefined' && value instanceof Response) {
    return new Error(`Response ${value.status} ${value.statusText}`.trim());
  }
  if (isRouteErrorResponseLike(value)) {
    const inner = (value as { error?: unknown }).error;
    if (inner instanceof Error) return inner;
    return new Error(`Route error response ${value.status} ${value.statusText}`.trim());
  }
  if (typeof value === 'string') return new Error(value);
  return new Error(`Non-Error value reported (${Object.prototype.toString.call(value)})`);
};

/**
 * Send one report through `sdk`, in its own scope: `surface` and the other
 * tags as tags (string values scrubbed, undefined dropped), the level, the
 * extras (secret keys dropped, strings scrubbed) and a `generic` mechanism
 * with `handled`. Used by the reporter below and by `captureServerException`.
 */
export const captureWithContext = (
  sdk: Pick<SentryReporterSdk, 'withScope' | 'captureException'>,
  error: unknown,
  context: Partial<ReportContext>
): void => {
  // Already sent by the SDK itself (its process or Express handler ran first).
  if (isSentryCaptured(error)) return;
  const reportable = toReportableError(error);
  sdk.withScope(scope => {
    if (context.surface) scope.setTag('surface', context.surface);
    for (const [key, value] of Object.entries(context.tags ?? {})) {
      if (value === undefined) continue;
      scope.setTag(key, typeof value === 'string' ? scrubText(value) : value);
    }
    scope.setLevel(context.level ?? 'error');
    if (context.extra) scope.setExtras(scrubValue(context.extra) as Record<string, unknown>);
    sdk.captureException(reportable, {
      mechanism: { type: 'generic', handled: context.handled ?? true },
    });
  });
  // The SDK marks what it was given (the wrapper); mark the original object
  // too, so the SDK's own handlers seeing it next do not send it again.
  if (reportable !== error) markSentryCaptured(error);
};

/**
 * Sentry core's per-object "already captured" marker (`__sentry_captured__`,
 * a non-enumerable property set by `checkOrSetAlreadyCaught`). Read and set
 * here so a non-Error object (wrapped before sending) is still sent once,
 * whichever of the SDK's handlers and `reportError` sees it first. Primitives
 * (a rejected string) cannot carry it: those can be sent once per layer.
 */
const SENTRY_CAPTURED = '__sentry_captured__';

const isSentryCaptured = (value: unknown): boolean => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return Boolean((value as Record<string, unknown>)[SENTRY_CAPTURED]);
  } catch {
    return false;
  }
};

const markSentryCaptured = (value: unknown): void => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  try {
    Object.defineProperty(value, SENTRY_CAPTURED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen or exotic objects keep their own shape.
  }
};

/**
 * The `ErrorReporter` for `setErrorReporter` (`@classmoji/utils/error-report`)
 * on top of a Sentry SDK. Node gets it from `initServerSentry`; a Worker
 * registers it itself once its Sentry client exists:
 * `setErrorReporter(createSentryReporter(Sentry))`.
 */
export const createSentryReporter = (sdk: SentryReporterSdk): ErrorReporter => ({
  capture: (error, context) => captureWithContext(sdk, error, context),
  flush: timeoutMs => Promise.resolve(sdk.flush(timeoutMs)),
});

// ---------------------------------------------------------------------------
// React Router
// ---------------------------------------------------------------------------

/**
 * For React Router's `handleError` (entry.server): whether this error is a
 * failure worth reporting. Not when the request was aborted (the client went
 * away), not for a thrown `Response` below 500 (redirects, 404s, 403s), not
 * for a route error response (`data()`/`isRouteErrorResponse` shape) below
 * 500. Everything else (real errors, 5xx) is reported. No react-router import.
 */
export const shouldReportRouteError = (
  error: unknown,
  request?: { signal?: { aborted?: boolean } }
): boolean => {
  if (request?.signal?.aborted) return false;
  if (typeof Response !== 'undefined' && error instanceof Response) return error.status >= 500;
  if (isRouteErrorResponseLike(error)) return error.status >= 500;
  return true;
};

const isRouteErrorResponseLike = (
  error: unknown
): error is { status: number; statusText: string; internal: boolean; data: unknown } =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { status?: unknown }).status === 'number' &&
  typeof (error as { statusText?: unknown }).statusText === 'string' &&
  typeof (error as { internal?: unknown }).internal === 'boolean' &&
  'data' in error;
