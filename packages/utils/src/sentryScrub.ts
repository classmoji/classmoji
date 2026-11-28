/**
 * The Sentry scrubbers, one set for browser and server events: what an event,
 * a breadcrumb or a span may carry once it leaves the process. PURE and
 * isomorphic (types only from the SDK, no `process`, no Node built-ins, no
 * reporter), so the browser clients (`@classmoji/utils/sentry-scrub`) and the
 * servers (`./sentryServer.ts` re-exports all of it) share the same rules.
 *
 * See `./sentryServer.ts`'s header for the privacy rules they implement.
 *
 * Linear time, whatever the input: every string is cut to a fixed length
 * BEFORE any pattern runs (URLs, paths and transaction names to
 * MAX_URL_LENGTH, other text to MAX_TEXT_LENGTH, with a visible TRUNCATED
 * marker), objects, arrays and breadcrumbs to a fixed count, and no pattern
 * has two unbounded repetitions over overlapping characters next to each
 * other: a pattern that starts with a repetition is anchored by a lookbehind
 * of the same class (one attempt per run), and key/value pairs and element
 * attributes are found by scanning, not by backtracking. Anyone can send a
 * request path; scrubbing it must never cost more than reading it.
 */
import type { Breadcrumb } from '@sentry/core';

// ---------------------------------------------------------------------------
// Length bounds
// ---------------------------------------------------------------------------

/** Longest URL or path (after its query is dropped) and transaction name sent. */
export const MAX_URL_LENGTH = 512;
/** Longest other string sent (exception messages, tags, extra values, …). */
export const MAX_TEXT_LENGTH = 4096;
/** Appended where a string was cut. */
export const TRUNCATED = '…[truncated]';
/** Most breadcrumbs an event keeps (the latest), as the SDK's own default. */
const MAX_BREADCRUMBS = 100;
/** Most entries kept from one object or array in extra, contexts or data. */
const MAX_ENTRIES = 100;
/** A key longer than this is dropped, never matched. */
const MAX_KEY_LENGTH = 128;
/** Nesting depth `scrubValue` copies; deeper values become `[depth]`. */
const MAX_DEPTH = 6;

const isWhitespace = (char: string | undefined): boolean =>
  char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\v';

/**
 * `text` cut to `max` characters. The cut never leaves half a token (half a
 * JWT, the local part of an email): the word it lands in is dropped too.
 */
const boundText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = max;
  if (!isWhitespace(text[end])) while (end > 0 && !isWhitespace(text[end - 1])) end--;
  return text.slice(0, end) + TRUNCATED;
};

/**
 * A URL or path (no query) cut to MAX_URL_LENGTH, back to the last `/` so no
 * half segment is left; `cut` says whether it was. The marker is added by the
 * caller after scrubbing, so it is never read as a segment.
 */
const boundUrl = (url: string): { url: string; cut: boolean } => {
  if (url.length <= MAX_URL_LENGTH) return { url, cut: false };
  const head = url.slice(0, MAX_URL_LENGTH);
  const slash = head.lastIndexOf('/');
  return { url: slash > 0 ? head.slice(0, slash + 1) : '', cut: true };
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Hosts the Github API rules apply to; `''` is a bare path (no host). */
const GITHUB_API = ['api.github.com', ''] as const;

/**
 * Path segments that are a credential or name a person, the single table of
 * them. A path is matched segment by segment, each segment percent-decoded and
 * compared case-insensitively (React Router matches routes the same way, so
 * `/JOIN/abc` and `/%6Aoin/abc` reach the join route too); a segment that does
 * not decode is replaced by `[segment]`. Only the listed segments change, the
 * rest stays as it was sent. `scrubText` applies the same table to bare paths
 * inside free text. Query strings are dropped before these run, so only
 * PATH-borne values are listed (`?token=`, `?sig=`, `?shareCode=`, `?invite=`,
 * `?username=`, `?q=` and every other query value never get this far).
 *
 * Pattern syntax: `literal` or `(a|b)` must equal the segment, `:name` is any
 * segment kept as it is, `[name]` is any segment replaced by `[name]` (`?`
 * after it: only when present; `[name].png`: a segment ending in `.png`,
 * replaced by `[name].png`). A leading `**` matches at any depth. `keep`
 * lists the static routes at a `[name]` position, left as they are
 * (`/admin/:class/teams/new` is a page, not a team). `hosts` limits a rule
 * to URLs on those hosts (`''`: a path with no host, as Octokit and Gitlab
 * errors quote them); `exceptHosts` keeps it off them.
 *
 * | Route                                                  | Value                     | Rewritten to                        |
 * | ------------------------------------------------------ | ------------------------- | ----------------------------------- |
 * | webapp `/join/:code`                                   | class invite code         | `/join/[code]`                      |
 * | webapp `/api/calendar/:slug/:signature.ics`            | calendar feed signature   | `/api/calendar/:slug/[signature]`   |
 * | better-auth `…/reset-password/:token`                  | password reset token      | `…/reset-password/[token]`          |
 * | content `/c/:id/theme/:theme/:tree/:p.v.exp.sig/…`     | signed policy segment     | `/c/:id/theme/:theme/:tree/[sig]/…` |
 * | content `/c/:id/files/:grant/:p.v.exp.sig/…`           | grant + signed policy     | `/c/:id/files/[grant]/[sig]/…`      |
 * | webapp `/{admin,teacher,assistant}/:class/students/:login` (not `add`) | a student's username | `…/students/[login]` |
 * | webapp `/{admin,teacher,assistant}/:class/staff/:login`  | a staff member's username | `…/staff/[login]`                   |
 * | webapp `/{…,student}/:class/teams/:slug` (not `new`)   | team slug (often names)   | `…/teams/[team]`                    |
 * | webapp `/{…,student}/:class/repos/:repo` (not `update`, `form`) | repository (student repos are named by login) | `…/repos/[repo]` |
 * | Gitlab `…/projects/:project` (API and web)             | project path (by login)   | `…/projects/[project]`              |
 * | Github API `/repos/:owner/:repo`                       | repository name           | `/repos/:owner/[repo]`              |
 * | Github API `/repos/:owner/:repo/collaborators/:login`  | a collaborator's username | `…/collaborators/[login]`           |
 * | Github API `/users/:login`                             | a username                | `/users/[login]`                    |
 * | Github API `/orgs/:org/{members,memberships}/:login`   | a member's username       | `…/[login]`                         |
 * | Github API `/orgs/:org/teams/:team[/memberships/:login]` | team slug, username     | `…/teams/[team]/memberships/[login]` |
 * | Github web `github.com/:owner/:repo`                   | repository name           | `/:owner/[repo]`                    |
 * | Github web `github.com/:login.png`                     | avatar (a username)       | `/[login].png`                      |
 * | admin `/people/:id`                                    | another person's user id  | `/people/[id]`                      |
 *
 * Classroom slugs and page, slide, assignment and other record ids stay; so
 * does a profile page `github.com/:login` (only the avatar form is
 * rewritten). After these, the token patterns of `scrubText` (JWTs,
 * `askmoji_…`, git and Stripe keys, …) run over the path too, so a token in
 * any other segment is still redacted. A new route with a credential, a
 * login, an email, a person's name or another person's id in its PATH goes
 * in this table (and a new static page beside one of these positions in its
 * `keep`: a test walks every app's route files).
 */
export const SENSITIVE_PATHS: ReadonlyArray<{
  name: string;
  pattern: string;
  keep?: readonly string[];
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
    keep: ['add'],
  },
  { name: 'staff login', pattern: '/(admin|teacher|assistant)/:class/staff/[login]' },
  {
    name: 'team slug',
    pattern: '/(admin|teacher|assistant|student)/:class/teams/[team]',
    keep: ['new'],
  },
  {
    name: 'repository name',
    pattern: '/(admin|teacher|assistant|student)/:class/repos/[repo]',
    keep: ['update', 'form'],
  },
  { name: 'Gitlab project path', pattern: '**/projects/[project]' },
  { name: 'Github API repository', pattern: '/repos/:owner/[repo]', hosts: GITHUB_API },
  {
    name: 'Github API collaborator',
    pattern: '/repos/:owner/[repo]/collaborators/[login]',
    hosts: GITHUB_API,
  },
  { name: 'Github API user', pattern: '/users/[login]', hosts: GITHUB_API },
  {
    name: 'Github API org member',
    pattern: '/orgs/:org/(members|memberships)/[login]',
    hosts: GITHUB_API,
  },
  { name: 'Github API team', pattern: '/orgs/:org/teams/[team]', hosts: GITHUB_API },
  {
    name: 'Github API team member',
    pattern: '/orgs/:org/teams/[team]/memberships/[login]',
    hosts: GITHUB_API,
  },
  { name: 'Github repository', pattern: '/:owner/[repo]', hosts: ['github.com'] },
  { name: 'Github avatar', pattern: '/[login].png', hosts: ['github.com'] },
  { name: 'person id (admin app)', pattern: '/people/[id]' },
];

type PathSegmentRule =
  | { kind: 'literal'; values: readonly string[] }
  | { kind: 'keep' }
  | { kind: 'redact'; label: string; suffix: string; optional: boolean };

type CompiledPathRule = {
  anyDepth: boolean;
  segments: PathSegmentRule[];
  keep: ReadonlySet<string>;
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
      const redact = /^\[(\w+)\](\.\w+)?(\?)?$/.exec(piece);
      if (redact) {
        return {
          kind: 'redact',
          label: redact[1],
          suffix: (redact[2] ?? '').toLowerCase(),
          optional: Boolean(redact[3]),
        };
      }
      if (piece.startsWith(':')) return { kind: 'keep' };
      const choice = /^\((.+)\)$/.exec(piece);
      return {
        kind: 'literal',
        values: (choice ? choice[1].split('|') : [piece]).map(v => v.toLowerCase()),
      };
    });
  return {
    anyDepth,
    segments,
    keep: new Set((rule.keep ?? []).map(v => v.toLowerCase())),
    hosts: rule.hosts,
    exceptHosts: rule.exceptHosts,
  };
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
 * `host` is the URL's host (lower case), `''` for a bare path.
 */
const rewriteSensitivePath = (path: string, host = ''): string => {
  const raw = path.split('/');
  const decoded = raw.map(decodeSegment);
  const out = raw.map((segment, i) => (decoded[i] === null ? '[segment]' : segment));
  // Index 0 is what precedes the first `/` (empty for a path).
  for (const rule of COMPILED_PATHS) {
    if (rule.hosts && !rule.hosts.includes(host)) continue;
    if (rule.exceptHosts?.includes(host)) continue;
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
        if (seg.kind === 'redact') {
          if (seg.suffix && !(value.endsWith(seg.suffix) && value.length > seg.suffix.length)) {
            matched = false;
            break;
          }
          if (!rule.keep.has(value)) redactAt.push([at, `[${seg.label}]${seg.suffix}`]);
        }
      }
      if (matched) for (const [at, label] of redactAt) out[at] = label;
    }
  }
  return out.join('/');
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Whether a key names a secret: its value is never sent, wherever it appears
 * in `extra`, `contexts`, breadcrumb data or span attributes. (Free text has
 * its own, narrower rule for names, `isSecretName` below.)
 *
 * The key is split into words (camelCase, snake_case, kebab-case, dotted),
 * then, in order:
 * - SECRET_KEY_ALLOW (the words joined): kept, though a rule below would
 *   drop it (`code` is a Prisma error code, `tokenCount` a count, …);
 * - SECRET_KEY_EXACT (the words joined): dropped (`headers`, `body`,
 *   `joinCode`, `invite`, `dsn`, …);
 * - any word in SECRET_WORDS: dropped (`x-collab-secret`, `sessionId`,
 *   `credentials`, `stripe_signature`);
 * - the last word in SECRET_LAST_WORDS: dropped (`accessToken`, `api_key`,
 *   `DB_PASS`).
 * Anything else is kept (`status_code`, `classroom_id`, `tokens_per_hour`).
 */
const SECRET_KEY_ALLOW = new Set([
  'code',
  'statuscode',
  'errorcode',
  'tokencount',
  'tokensperhour',
  'filterkey',
  'signatureversion',
  'cookieconsent',
  'tokenizer',
]);
const SECRET_KEY_EXACT = new Set([
  'header',
  'headers',
  'body',
  'query',
  'querystring',
  'httpquery',
  'urlquery',
  'httpfragment',
  'urlfragment',
  'sig',
  'dsn',
  'invite',
  'joincode',
  'sharecode',
  'invitecode',
  'authcode',
  'otpcode',
  'apikey',
  'privatekey',
  'accesskey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'clientsecret',
]);
const SECRET_WORDS = new Set([
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'authorization',
  'cookie',
  'cookies',
  'session',
  'jwt',
  'signature',
  'credential',
  'credentials',
  'apikey',
]);
const SECRET_LAST_WORDS = new Set(['token', 'key', 'secret', 'pass']);

/** `x-collabSecret_v2` → `['x', 'collab', 'secret', 'v2']`. */
const keyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The narrower rule for NAMES in free text (`name: value`, `name=value`):
 * prose says `cache key:`, `query:`, `session:` and `body:`, so only a name
 * that says secret, password, token, signature, cookie or authorization (or
 * an invite, join or share code, `sig`, an API or private key, or an env-style
 * `SOME_KEY`) counts.
 */
const SECRET_TEXT_WORDS = new Set([
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'cookie',
  'jwt',
  'signature',
  'credential',
  'credentials',
]);
const SECRET_TEXT_EXACT = new Set(['sig', 'invite', 'joincode', 'sharecode', 'invitecode']);
const SECRET_TEXT_SUFFIXES = ['apikey', 'privatekey', 'secretkey', 'accesskey', 'signingkey'];

const isSecretName = (name: string): boolean => {
  const words = keyWords(name);
  const joined = words.join('');
  if (SECRET_KEY_ALLOW.has(joined)) return false;
  if (SECRET_TEXT_EXACT.has(joined)) return true;
  if (words.some(word => SECRET_TEXT_WORDS.has(word))) return true;
  const last = words[words.length - 1] ?? '';
  if (last === 'token' || last === 'secret' || last === 'pass') return true;
  // An env-style name (`ENCRYPTION_KEY=`, `DEPLOY_KEY:`); prose `cache key:` is not one.
  if (last === 'key' && /^[A-Z][A-Z0-9_]*$/.test(name)) return true;
  return SECRET_TEXT_SUFFIXES.some(suffix => joined.endsWith(suffix));
};

export const isSecretKey = (key: string): boolean => {
  if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return true;
  const words = keyWords(key);
  const joined = words.join('');
  if (SECRET_KEY_ALLOW.has(joined)) return false;
  if (SECRET_KEY_EXACT.has(joined)) return true;
  if (words.some(word => SECRET_WORDS.has(word))) return true;
  return SECRET_LAST_WORDS.has(words[words.length - 1] ?? '');
};

// ---------------------------------------------------------------------------
// Free-text rules
// ---------------------------------------------------------------------------

/**
 * V8's `JSON.parse` messages quote the input they refused (`Unexpected token
 * 'J', "Jane Doe, "... is not valid JSON`), so `request.json()` on a posted
 * body puts up to ~20 characters of it in the message. The quoted part
 * becomes `"[input]"`; the token, the error kind and, in the other messages,
 * the position stay. Leftmost match, so an earlier quote may be swallowed
 * too, never less than the input.
 */
const JSON_PARSE_INPUT = /(?:\.\.\.)?"[\s\S]{0,64}?"(?:\.\.\.)? is not valid JSON/g;
const UNEXPECTED_TOKEN = "Unexpected token '";

const redactJsonParseInput = (text: string): string =>
  text.includes(' is not valid JSON')
    ? text.replace(JSON_PARSE_INPUT, match => {
        // Keep our own text before the quote, up to V8's `Unexpected token 'x', `.
        const at = match.lastIndexOf(UNEXPECTED_TOKEN);
        const comma = at === -1 ? -1 : match.indexOf("', ", at + UNEXPECTED_TOKEN.length);
        const kept = comma === -1 ? '' : match.slice(0, comma + 3);
        return `${kept}"[input]" is not valid JSON`;
      })
    : text;

/**
 * Tokens and keys that may turn up in error messages, each with its stand-in.
 * Each starts at a literal prefix or behind a lookbehind of its own class.
 */
const TOKEN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // `Authorization: Bearer …` / `authorization=Basic …`: the credential, any length.
  [
    /\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8})(Bearer|Basic)[ \t]{1,4}[A-Za-z0-9._~+/=-]+/gi,
    '$1$2 [redacted]',
  ],
  // An Authorization credential quoted in a message: `Bearer`/`Basic` and 16+ token characters.
  [/\b(Bearer|Basic)[ \t]{1,4}[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  // JWTs (access tokens, id tokens): three base64url parts, the first `eyJ`.
  [/(?<![\w-])eyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[jwt]'],
  // Two-part signed tokens (base64url JSON `eyJ…`, `.`, a signature), as the
  // class invite and class-site return tokens are.
  [/(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}/g, '[signed-token]'],
  // Classmoji's own MCP tokens.
  [/(?<![\w-])askmoji_[\w-]+/g, 'askmoji_[redacted]'],
  // Github tokens: personal, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  [/(?<!\w)gh[pousr]_\w+/g, '[github-token]'],
  [/(?<!\w)github_pat_\w+/g, '[github-token]'],
  // Gitlab tokens (personal, OAuth app secret, deploy, runner, trigger, feed, …).
  [
    /(?<![\w-])gl(?:pat|oas|dt|rt|ptt|ft|imt|agent|cbt|soat|ffct|wt|rtr|feat)-[\w-]+/g,
    '[gitlab-token]',
  ],
  // Stripe secret and restricted keys, webhook signing secrets (Stripe, Svix/Resend).
  [/(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[stripe-key]'],
  [/(?<!\w)whsec_[A-Za-z0-9+/=_-]+/g, '[webhook-secret]'],
  // Anthropic (`sk-ant-…`) and OpenAI project (`sk-proj-…`) API keys.
  [/(?<![\w-])sk-(?:ant|proj)-[\w-]+/g, '[api-key]'],
  // Resend API keys: `re_`, 8 characters, `_`, 24 or more.
  [/(?<!\w)re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24,40}(?!\w)/g, '[api-key]'],
  // AWS access key ids.
  [/(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g, '[aws-key]'],
  // better-auth's session cookie values, if a message ever quotes a Cookie header.
  [/(session_(?:token|data))=[^;\s"'`]+/gi, '$1=[redacted]'],
  // Stripe (and Stripe-style) webhook signature values: `t=…,v1=…`.
  [/(?<!\w)t=\d{1,12}(?:,v\d{1,3}=[0-9a-f]{1,256})+/gi, '[signature]'],
];

/**
 * A name and its separator: `name:`, `name =`, `"name":`, `'name': `. One
 * attempt per run of name characters (the lookbehind), the name at most 64
 * characters, so it never backtracks further than that.
 */
const NAME_AND_SEPARATOR = /(?<![\w.-])(["']?)([A-Za-z_][\w.-]{0,63})\1[ \t]{0,8}([:=])[ \t]{0,8}/g;
/** A bare value: everything up to whitespace, a quote or a delimiter. */
const BARE_VALUE = /[^\s"'`,;&<>(){}[\]]*/y;
/** A bare value this long is a secret's; shorter is a word (`Invalid token: jwt expired`). */
const MIN_BARE_SECRET_LENGTH = 12;
/** Longest quoted value looked for; an unclosed or longer one runs to the end of its line. */
const MAX_QUOTED_LENGTH = 1024;

/** Where a header's value ends: the end of its line, or a quote. */
const endOfLine = (text: string, from: number, stopAtQuotes: boolean): number => {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n' || c === '\r') break;
    if (stopAtQuotes && (c === '"' || c === "'" || c === '`')) break;
    i++;
  }
  return i;
};

/** Where a value quoted with `quote` at `from` ends (after the closing quote). */
const endOfQuoted = (text: string, from: number, quote: string): number => {
  const limit = Math.min(text.length, from + 1 + MAX_QUOTED_LENGTH);
  for (let i = from + 1; i < limit; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === quote) return i + 1;
    else if (c === '\n' || c === '\r') return i;
  }
  return endOfLine(text, limit, false);
};

/** A header-shaped name (`x-collab-secret`, `Cookie`, `Authorization`). */
const isHeaderName = (name: string): boolean =>
  name.includes('-') || /^(?:cookie|authorization)$/i.test(name);

/**
 * A name that says secret beyond doubt (`password`, `passwd`, `secret`,
 * `client_secret`, `COLLAB_INTERNAL_SECRET`, `x-collab-secret`, `api_key`,
 * `apikey`, `RESEND_API_KEY`): its bare value is redacted however short (see
 * `isSecretBareValue`). Other secret names (`token`, `signature`, `sig`,
 * `ENCRYPTION_KEY`, …) keep the MIN_BARE_SECRET_LENGTH rule, since prose
 * says `Invalid token: jwt expired`.
 */
const UNAMBIGUOUS_SECRET_WORDS = new Set(['password', 'passwords', 'passwd', 'secret', 'secrets']);
const isUnambiguousSecretName = (name: string): boolean => {
  const words = keyWords(name);
  return (
    words.some(word => UNAMBIGUOUS_SECRET_WORDS.has(word)) || words.join('').endsWith('apikey')
  );
};

/**
 * Words that say a value is absent or what kind it is, never a value
 * (`password: required`, `secret: undefined`, `authorization: missing`):
 * kept after any secret name.
 */
const NON_VALUES = new Set([
  'null',
  'undefined',
  'none',
  'true',
  'false',
  'empty',
  'missing',
  'required',
  'unset',
]);

/**
 * Whether a bare value after an unambiguous secret name is the secret:
 * after `=` always (`password=hunter2`, `COLLAB_INTERNAL_SECRET=short`,
 * `api_key=abc1`, `password=null`); after `:`, when it has at least 4
 * characters or any digit or capital (`secret: shortpw`, `password: Ab1`)
 * and is not one of NON_VALUES, so prose stays (`password: is too short`,
 * `secret: not set`, `password: required`).
 */
const isSecretBareValue = (value: string, separator: string): boolean => {
  if (!value) return false;
  if (separator === '=') return true;
  if (NON_VALUES.has(value.toLowerCase())) return false;
  return value.length >= 4 || /[0-9A-Z]/.test(value);
};

/**
 * Whether a header's single token is credential-shaped rather than a word of
 * prose: MIN_BARE_SECRET_LENGTH characters, or a digit, or a capital after a
 * lower-case letter (`aB3x`, `abcDEF`, not `Role`, `STUDENT`, `role`).
 */
const isCredentialShaped = (token: string): boolean =>
  token.length >= MIN_BARE_SECRET_LENGTH || /\d/.test(token) || /[a-z][A-Z]/.test(token);

/** Auth schemes a header value may start with (`Bearer abc`, `token ghp_…`). */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'token', 'bot', 'digest', 'negotiate', 'dpop']);

/** Where the bare value starting at `from` ends. */
const bareValueEnd = (text: string, from: number): number => {
  BARE_VALUE.lastIndex = from;
  BARE_VALUE.exec(text);
  return BARE_VALUE.lastIndex;
};

/** One cookie pair: up to whitespace, a quote, `,` or `;`. */
const COOKIE_PAIR = /[^\s"'`,;]*/y;

/** Where the cookie pair starting at `from` ends. */
const cookiePairEnd = (text: string, from: number): number => {
  COOKIE_PAIR.lastIndex = from;
  COOKIE_PAIR.exec(text);
  return COOKIE_PAIR.lastIndex;
};

/** Index of the first character after at most 8 spaces or tabs from `from`. */
const skipBlanks = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && i - from < 8 && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
};

/**
 * Whether nothing of the value follows `from`: the end of the text or the
 * line, or a delimiter or quote, after at most a few blanks. A token that is
 * the whole value is a credential; one followed by more words is prose.
 */
const valueEndsAt = (text: string, from: number): boolean => {
  const i = skipBlanks(text, from);
  return i >= text.length || '\n\r,;)}]>"\'`'.includes(text[i]);
};

/**
 * The span of a secret-named header's value that is redacted (`[from, to)`,
 * empty for none). Only a credential-shaped value, never the prose after it:
 * - a cookie list (`Cookie: a=b; session=c`): the whole list of pairs;
 * - an auth scheme and its credential (`Authorization: Token abc123 for x`):
 *   the credential, the scheme stays (Bearer and Basic after
 *   `Authorization:` were already redacted by TOKEN_PATTERNS, any length);
 * - a single token (`x-collab-secret: s3cr3t to collab`): that token, when
 *   it is credential-shaped or the whole value (after an unambiguous name,
 *   as `isSecretBareValue` says, or the whole value);
 * - a second token that is credential-shaped (`Authorization: Splunk 0123…`,
 *   a scheme not listed): that one, with the first when it is one too.
 * So `authorization: role STUDENT cannot edit c1` stays as it is.
 */
const headerSecretSpan = (text: string, start: number, name: string): [number, number] => {
  const tokenEnd = bareValueEnd(text, start);
  if (tokenEnd === start) return [start, start];
  const token = text.slice(start, tokenEnd);
  if (/cookie/i.test(name) && token.includes('=')) {
    // Every `name=value` pair, `;`-separated (a value may already read `[redacted]`).
    let end = cookiePairEnd(text, start);
    while (text[end] === ';') {
      const next = skipBlanks(text, end + 1);
      const pairEnd = cookiePairEnd(text, next);
      if (pairEnd === next) break;
      end = pairEnd;
    }
    return [start, end];
  }
  const afterScheme = skipBlanks(text, tokenEnd);
  if (AUTH_SCHEMES.has(token.toLowerCase()) && afterScheme > tokenEnd) {
    const credentialEnd = bareValueEnd(text, afterScheme);
    const credential = text.slice(afterScheme, credentialEnd);
    if (
      credential &&
      (isCredentialShaped(credential) ||
        valueEndsAt(text, credentialEnd) ||
        isUnambiguousSecretName(name))
    ) {
      return [afterScheme, credentialEnd];
    }
    return [start, start];
  }
  const whole = valueEndsAt(text, tokenEnd);
  const firstSecret =
    !NON_VALUES.has(token.toLowerCase()) &&
    (isUnambiguousSecretName(name) ? isSecretBareValue(token, ':') : isCredentialShaped(token));
  const secondEnd = whole ? afterScheme : bareValueEnd(text, afterScheme);
  const secondSecret =
    afterScheme > tokenEnd && isCredentialShaped(text.slice(afterScheme, secondEnd));
  if (secondSecret) return [firstSecret ? start : afterScheme, secondEnd];
  if (firstSecret || (whole && !NON_VALUES.has(token.toLowerCase()))) return [start, tokenEnd];
  return [start, start];
};

/**
 * Values whose name is a secret (`isSecretName`), found by scanning:
 * - a quoted value (`"password":"…"`, `client_secret: '…'`, `cookie: '…'`):
 *   the quotes and all;
 * - a header (`x-collab-secret: …`, `Cookie: …`, `Authorization: …`): its
 *   credential-shaped value only, up to the value's end (`headerSecretSpan`);
 * - a bare value (`token=…`, `GITHUB_TOKEN: …`): when it has at least
 *   MIN_BARE_SECRET_LENGTH characters, or after an unambiguous name
 *   (`password=…`, `secret: …`) as `isSecretBareValue` says.
 * A value left alone is shorter than MIN_BARE_SECRET_LENGTH, so rescanning
 * from inside it stays linear.
 */
const redactSecretValues = (text: string): string => {
  const pattern = new RegExp(NAME_AND_SEPARATOR.source, 'g');
  let out = '';
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const [, quote, name, separator] = m;
    if (!isSecretName(name)) continue;
    const valueStart = pattern.lastIndex;
    const first = text[valueStart];
    let from = valueStart;
    let to = valueStart;
    if (first === '"' || first === "'") {
      to = endOfQuoted(text, valueStart, first);
    } else if (separator === ':' && !quote && isHeaderName(name)) {
      [from, to] = headerSecretSpan(text, valueStart, name);
    } else {
      const end = bareValueEnd(text, valueStart);
      const value = text.slice(valueStart, end);
      const secret = isUnambiguousSecretName(name)
        ? isSecretBareValue(value, separator)
        : value.length >= MIN_BARE_SECRET_LENGTH;
      if (secret) to = end;
    }
    if (to > from) {
      out += `${text.slice(last, from)}[redacted]`;
      last = to;
      pattern.lastIndex = to;
    }
  }
  return out + text.slice(last);
};

/** Email addresses: a bounded local part, labels and a letter TLD. */
const EMAIL =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

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

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/**
 * A dotted quad standing on its own: not right after a letter, a digit, `_`,
 * `/` or `.` (`Chrome/131.0.0.0`, `v1.2.3.4`, `1.2.3.4.5` are versions), and
 * not followed by a letter, digit or `.digit`.
 */
const IPV4 = new RegExp(`(?<![\\w/.])${OCTET}(?:\\.${OCTET}){3}(?![\\w]|\\.\\d)`, 'g');
/**
 * A global unicast IPv6 address (2000::/3, the only public range): a first
 * group of four hex digits starting with 2 or 3, then two to seven more
 * groups, written in full (eight groups) or with `::`. Internal ranges
 * (fc00::/7, fe80::/10, ::1) never match, nor do `dead::beef`, `Foo::bar`
 * or clock times.
 */
const IPV6 = /(?<![\w:.])[23][0-9a-f]{3}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const isIPv6Shape = (candidate: string): boolean =>
  !candidate.includes(':::') && (candidate.includes('::') || candidate.split(':').length === 8);

const scrubIps = (text: string): string =>
  text
    .replace(IPV4, ip => (isInternalIPv4(ip) ? ip : '[ip]'))
    .replace(IPV6, ip => (isIPv6Shape(ip) ? '[ip]' : ip));

type TextOptions = { ips?: boolean };

const scrubTokens = (text: string, options: TextOptions = {}): string => {
  let out = text;
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  out = redactSecretValues(out).replace(EMAIL, '[email]');
  return options.ips === false ? out : scrubIps(out);
};

/** Rewrite a path (no query, no fragment) through SENSITIVE_PATHS, then token patterns. */
const scrubPath = (path: string, host?: string): string =>
  scrubTokens(rewriteSensitivePath(path, host));

const SCHEME_AND_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is;

/**
 * A URL as it may be sent: no query string, no fragment, no `user:password@`,
 * credential path segments rewritten, tokens redacted, cut to MAX_URL_LENGTH.
 * Accepts absolute URLs (any scheme, so `postgres://user:pw@host/db` loses
 * its password) and bare paths. A `data:` URL keeps only its media type.
 */
export const scrubUrl = (url: string): string => {
  if (typeof url !== 'string' || !url) return url;
  const dataUrl = /^data:([^,;]{0,64})/i.exec(url);
  if (dataUrl) return `data:${dataUrl[1]},[data]`;
  const cut = url.search(/[?#]/);
  const bounded = boundUrl(cut === -1 ? url : url.slice(0, cut));
  const marker = bounded.cut ? TRUNCATED : '';
  const parts = SCHEME_AND_AUTHORITY.exec(bounded.url);
  if (!parts) return scrubPath(bounded.url) + marker;
  const [, scheme, authority, path] = parts;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return `${scheme}${scrubIps(host)}${scrubPath(path, hostname)}${marker}`;
};

/** Absolute URLs (any scheme) inside free text; one attempt per run of scheme characters. */
const URL_IN_TEXT = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'`<>]+/gi;
/**
 * Bare paths inside free text (`No route matches URL "/join/abc?x=1"`): a `/`
 * at the start or after a quote, space, bracket, `=`, `:` or `,`, then path
 * characters and an optional query. Only the credential rules and the query
 * strip apply to these.
 */
const PATH_IN_TEXT = /(^|[\s"'`([<=:,])(\/[^\s"'`<>()[\]?#]*)(?:[?#][^\s"'`<>()[\]]*)?/g;
/** Sentence punctuation that ends a URL in prose. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', ')', ']']);

const scrubTextWith = (input: string, options: TextOptions): string => {
  if (typeof input !== 'string' || !input) return input;
  const text = redactJsonParseInput(boundText(input, MAX_TEXT_LENGTH));
  const placeholders: string[] = [];
  // URLs first, parked behind placeholders so the path pass does not see
  // their paths a second time.
  let out = text.replace(URL_IN_TEXT, match => {
    let end = match.length;
    while (end > 0 && TRAILING_PUNCTUATION.has(match[end - 1])) end--;
    placeholders.push(scrubUrl(match.slice(0, end)) + match.slice(end));
    return `${placeholders.length - 1}`;
  });
  out = out.replace(
    PATH_IN_TEXT,
    (_match, lead: string, path: string) => lead + rewriteSensitivePath(path)
  );
  out = scrubTokens(out, options);
  return out.replace(/(\d{1,6})/g, (_m, index: string) => placeholders[Number(index)] ?? '');
};

/**
 * Free text as it may be sent: cut to MAX_TEXT_LENGTH, the input quoted in a
 * `JSON.parse` message dropped, URLs through `scrubUrl`, query strings cut
 * from bare paths, credential paths rewritten, tokens, keys, secret values,
 * emails and public IP addresses redacted.
 */
export const scrubText = (text: string): string => scrubTextWith(text, {});

/** Deep copy of a JSON-ish value with secret keys dropped and every string scrubbed. */
export const scrubValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map(item => scrubValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (kept++ >= MAX_ENTRIES) break;
    if (isSecretKey(key)) continue;
    const item = (value as Record<string, unknown>)[key];
    out[key] =
      key === 'url' && typeof item === 'string' ? scrubUrl(item) : scrubValue(item, depth + 1);
  }
  return out;
};

/** `GET /join/abc` → `GET /join/[code]`; anything else through scrubText, cut to MAX_URL_LENGTH. */
export const scrubTransaction = (transaction: string): string => {
  if (typeof transaction !== 'string') return transaction;
  const routed = /^([A-Z]{1,16}) (\S+)$/.exec(transaction);
  return routed
    ? `${routed[1]} ${scrubUrl(routed[2])}`
    : scrubText(boundText(transaction, MAX_URL_LENGTH));
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

/**
 * The listed headers (case-insensitive), undefined when none is left. A
 * referrer is a URL (`scrubUrl`); any other value is text, without the IP
 * rule (a User-Agent's `Chrome/131.0.0.0` is a version, not an address).
 */
const keepHeaders = (
  headers: Record<string, unknown> | undefined,
  allow: readonly string[]
): Record<string, string> | undefined => {
  if (!headers || typeof headers !== 'object' || allow.length === 0) return undefined;
  const wanted = allow.map(name => name.toLowerCase());
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (typeof value !== 'string' || !wanted.includes(name.toLowerCase())) continue;
    out[name] = /^referr?er$/i.test(name) ? scrubUrl(value) : scrubTextWith(value, { ips: false });
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
 * - `breadcrumbs` → the latest MAX_BREADCRUMBS through `scrubBreadcrumb`
 *   (console ones dropped);
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
      event.logentry.params = event.logentry.params
        .slice(0, MAX_ENTRIES)
        .map(param => scrubValue(param));
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
      .slice(-MAX_BREADCRUMBS)
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
 * so only the attribute names stay (`[title]`). A value may itself hold
 * quotes and brackets, so it ends at the first `"]` followed by the next
 * attribute (`[`), the next element (` > `) or the end. Found by scanning:
 * the ends are listed once, so the cost is linear in the path.
 */
const ATTRIBUTE_START = /\[([\w:-]{1,64})="/g;

/** Indexes of every `"]` that can end an attribute value, in order. */
const attributeEnds = (path: string): number[] => {
  const ends: number[] = [];
  for (let i = path.indexOf('"]'); i !== -1; i = path.indexOf('"]', i + 1)) {
    const next = i + 2;
    if (next === path.length || path[next] === '[' || /^\s>\s/.test(path.slice(next, next + 3))) {
      ends.push(i);
    }
  }
  return ends;
};

/** `[title="…"]` → `[title]` throughout an element path. */
export const stripElementAttributes = (path: string): string => {
  if (typeof path !== 'string' || !path.includes('="')) return path;
  const ends = attributeEnds(path);
  const start = new RegExp(ATTRIBUTE_START.source, 'g');
  let out = '';
  let last = 0;
  let e = 0;
  for (let m = start.exec(path); m; m = start.exec(path)) {
    const valueStart = start.lastIndex;
    while (e < ends.length && ends[e] < valueStart) e++;
    if (e === ends.length) break;
    out += `${path.slice(last, m.index)}[${m[1]}]`;
    last = ends[e] + 2;
    start.lastIndex = last;
  }
  return out + path.slice(last);
};

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
