/**
 * safeUrlFetch.ts — fetch a URL someone else chose, without letting it reach
 * anything it should not.
 *
 * The `media-import-url` task downloads a file from a URL supplied by an MCP
 * caller and streams it into storage. The URL is untrusted input and the task
 * runs on our infrastructure, so an unguarded fetch is a server-side request
 * forgery primitive: it would happily read a cloud metadata endpoint, a
 * database on a private network, or a port on localhost, and hand the bytes
 * back as an "uploaded file". Everything here exists to close that off.
 *
 * ── The rules, and where each one lives ───────────────────────────────────
 *  1. `parseImportUrl` — https only, port 443 only (an explicit other port is
 *     refused; `:443` normalises to the default and is fine), no userinfo in
 *     the URL (credentials would be sent to whoever answers), a real host.
 *  2. `resolvePublicAddress` — resolve the host to EVERY A/AAAA record and
 *     refuse if ANY of them is non-public. Checking only the first record is
 *     not enough: a name that answers `[public, 127.0.0.1]` would pass, and
 *     the socket layer's own address selection could then pick the private
 *     one. A literal-IP host is checked directly (no DNS).
 *  3. `createPinnedAgent` — connect to the address validated in step 2 and
 *     NOTHING else. Resolving a second time at connect time is exactly the
 *     window a DNS-rebinding attack uses (answer public for the check,
 *     private for the connect), so the Agent's `connect.lookup` is replaced by
 *     one that hands back the pre-validated address without asking DNS. The
 *     hostname itself is untouched — undici still derives SNI and the `Host`
 *     header from the URL, so TLS verifies the real site's certificate.
 *     A host that does not resolve and one that resolves somewhere private
 *     get the SAME message (`HOST_NOT_PUBLIC_MESSAGE`).
 *  4. `fetchImportUrl` — no redirects (a 3xx is refused as `REDIRECT_REFUSED`,
 *     because following one would need steps 1–3 again for a URL the caller
 *     never showed us; the message tells them to pass the final URL instead),
 *     no credentials of ours on the request, a connect/headers timeout, an
 *     overall deadline, and a byte cap enforced on the bytes actually
 *     received, independent of whatever `Content-Length` claims.
 *
 * ── Why undici's `request`, not `fetch` ───────────────────────────────────
 * Both accept a `dispatcher`, but they differ in two ways that matter here:
 *  - `request` never follows redirects (in undici 7 that is opt-in via the
 *    `redirect` interceptor, which we do not compose), so a 3xx simply comes
 *    back as a status code. Nothing to configure, nothing to get wrong.
 *  - `request` does not decompress. We send `accept-encoding: identity`, and
 *    whatever the server sends is what we store, byte for byte — so the cap
 *    counts the bytes that will occupy storage. With `fetch`, a small gzip
 *    body would be inflated before the cap saw it. A response that comes back
 *    with any other `content-encoding` anyway is refused
 *    (`UNSUPPORTED_ENCODING`): it would be stored compressed, as a file no
 *    player or viewer could open.
 * It is undici's OWN `request` with undici's OWN `Agent`; Node's global
 * `fetch` bundles a different undici build whose dispatcher interface need
 * not match the installed package.
 *
 * ── Failures ──────────────────────────────────────────────────────────────
 * Every refusal is a `UrlImportError` with a stable `code`; messages are safe
 * to show the caller (they name the URL's host at most, never our internals).
 *
 * ── Test seam ─────────────────────────────────────────────────────────────
 * `__testOnlyDispatcher` swaps the pinned Agent for a mock so the HTTP-level
 * behaviour (redirects, status codes, the byte cap) can be exercised without
 * TLS or real DNS. It is refused outright unless running under Vitest, so no
 * production caller can use it to bypass the pin, even by accident.
 */

import { promises as dns } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';

import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';

// ─── Errors ──────────────────────────────────────────────────────────────────

export type UrlImportErrorCode =
  /** Not a URL we accept: wrong scheme, a port, userinfo, no host, too long. */
  | 'BAD_URL'
  /** The host is, or resolves to, an address that is not public. */
  | 'BLOCKED_ADDRESS'
  /** The host did not resolve. */
  | 'DNS_FAILED'
  /** The server answered 3xx. We do not follow redirects. */
  | 'REDIRECT_REFUSED'
  /** The server answered with a status outside 2xx/3xx; see `status`. */
  | 'HTTP_ERROR'
  /** Declared or actual body size exceeds the cap. */
  | 'TOO_LARGE'
  /** The server compressed the body (`content-encoding` other than identity). */
  | 'UNSUPPORTED_ENCODING'
  /** Connect, headers, body-idle, or overall deadline exceeded. */
  | 'TIMEOUT'
  /** The connection itself failed: refused, reset, TLS verification, etc. */
  | 'FETCH_FAILED';

/**
 * The ONE sentence for a host that did not resolve and for one that resolved
 * somewhere private. Two different sentences would let a caller map our
 * network from outside — "could not resolve" versus "private address" answers
 * whether an internal name exists. The codes stay distinct (`DNS_FAILED` is
 * worth a retry, `BLOCKED_ADDRESS` is not); only what is SAID is the same.
 */
export const HOST_NOT_PUBLIC_MESSAGE =
  "That URL's host does not resolve to a public internet address.";

/** A URL import that was refused or failed. `message` is safe to show the caller. */
export class UrlImportError extends Error {
  readonly code: UrlImportErrorCode;
  /** HTTP status, for `HTTP_ERROR` and `REDIRECT_REFUSED`. */
  readonly status?: number;

  constructor(code: UrlImportErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'UrlImportError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ─── Address classification ─────────────────────────────────────────────────

/**
 * IPv4 ranges that are not publicly routable, or that reach something on or
 * next to our own host. `[network, prefixLength]`, network as dotted quad.
 * Sources: RFC 6890 special-purpose registry, plus 169.254.169.254 (cloud
 * metadata) which sits inside the link-local /16.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network", incl. 0.0.0.0 (unspecified — Linux routes it to localhost)
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (shared address space)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // Strict decimal only. `isIP` has already rejected octal/hex forms, and
    // the WHATWG URL parser normalises those to dotted decimal anyway.
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const BLOCKED_V4_NUMERIC = BLOCKED_V4.map(([net, bits]) => {
  const base = parseIPv4(net);
  if (base === null) throw new Error(`safeUrlFetch: malformed range ${net}`);
  // Computed with arithmetic rather than `<<`, which is signed 32-bit in JS.
  const size = 2 ** (32 - bits);
  return { base, size };
});

function isBlockedV4(n: number): boolean {
  return BLOCKED_V4_NUMERIC.some(({ base, size }) => n >= base && n < base + size);
}

/**
 * Parse an IPv6 address into 8 16-bit groups. Handles `::` compression and a
 * trailing embedded dotted quad (`::ffff:1.2.3.4`). Returns null for anything
 * it does not understand, which the caller treats as blocked.
 */
function parseIPv6(ip: string): number[] | null {
  let s = ip;
  // Rewrite a trailing dotted quad as two hex groups, then parse uniformly.
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || rest === null) return null;
  const explicit = head.length + rest.length;
  if (halves.length === 1) return explicit === 8 ? head : null;
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
}

/** The IPv4 address embedded in groups 6–7 of an IPv6 address. */
function embeddedV4(g: number[], from = 6): number {
  return g[from] * 65536 + g[from + 1];
}

function isBlockedV6(g: number[]): boolean {
  const allZeroUpTo = (n: number) => g.slice(0, n).every(x => x === 0);

  // ::ffff:0:0/96 — IPv4-mapped. The socket really talks IPv4, to the
  // embedded address, so the IPv4 rules decide.
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g));
  // 64:ff9b::/96 — well-known NAT64 prefix; the translator forwards to the
  // embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isBlockedV4(embeddedV4(g));
  }
  // 2002::/16 — 6to4; groups 1–2 carry the IPv4 address of the site.
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g, 1));

  // Everything below is an ALLOWLIST: only 2000::/3 is global unicast. That
  // single test excludes ::, ::1, ::/96, 100::/64, 64:ff9b:1::/48, fc00::/7
  // (incl. fd00:ec2::254 metadata), fe80::/10, ff00::/8 and every future
  // special range outside it, without having to enumerate them.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  // Carve-outs inside 2000::/3.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo tunnelling
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
  return false;
}

/**
 * True when `ip` must not be connected to: private, loopback, link-local,
 * CGNAT, metadata, unspecified, multicast, broadcast, documentation or
 * otherwise reserved. Anything that is not a parseable IP literal, and any
 * IPv6 address carrying a zone id (`fe80::1%eth0`), is blocked — fail closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (bare.includes('%')) return true;
  const family = isIP(bare);
  if (family === 4) {
    const n = parseIPv4(bare);
    return n === null ? true : isBlockedV4(n);
  }
  if (family === 6) {
    const g = parseIPv6(bare);
    return g === null ? true : isBlockedV6(g);
  }
  return true;
}

// ─── URL validation ─────────────────────────────────────────────────────────

/** Longer than any real download link; a cheap bound on what we parse and echo. */
const MAX_URL_LENGTH = 4096;

/**
 * Parse and validate an import URL. Throws `UrlImportError('BAD_URL')` for
 * anything but `https://host/…` on the default port with no userinfo.
 *
 * The WHATWG parser does useful normalisation first: `https://0x7f.1/` and
 * `https://2130706433/` both become `127.0.0.1`, and `https://h:443/` loses
 * its port, so the checks below (and the literal-IP check in
 * `resolvePublicAddress`) see canonical values.
 */
export function parseImportUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new UrlImportError('BAD_URL', 'The URL is empty or too long.');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlImportError('BAD_URL', 'The URL could not be parsed.');
  }
  if (url.protocol !== 'https:') {
    throw new UrlImportError('BAD_URL', 'Only https:// URLs can be imported.');
  }
  if (url.port !== '') {
    throw new UrlImportError('BAD_URL', 'Only the default https port (443) is allowed.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UrlImportError('BAD_URL', 'URLs containing a username or password are not accepted.');
  }
  if (url.hostname === '') {
    throw new UrlImportError('BAD_URL', 'The URL has no host.');
  }
  return url;
}

// ─── DNS ────────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveAll = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Default resolver: `dns.lookup` with `all: true`, i.e. getaddrinfo. That is
 * the same path Node's own `connect` would take — it honours /etc/hosts and
 * the system's `localhost` handling — so we validate exactly the set of
 * addresses the OS would otherwise have connected to. `Resolver.resolve4/6`
 * would query DNS servers directly and skip /etc/hosts, validating a
 * different set than the one a naive connect would use.
 */
const defaultResolveAll: ResolveAll = async hostname => {
  const records = await dns.lookup(hostname, { all: true, order: 'verbatim' });
  return records.map(r => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Resolve `hostname` to a single address that is safe to connect to.
 *
 * EVERY record must be public — one private record refuses the whole host,
 * because we cannot know which record another resolver (or a retry) would
 * pick. A literal IP (bracketed IPv6 as `URL.hostname` gives it is fine) is
 * checked directly. Of the validated records, IPv4 is preferred: task
 * machines are not guaranteed IPv6 egress.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolveAll: ResolveAll = defaultResolveAll
): Promise<ResolvedAddress> {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host)) {
      throw new UrlImportError('BLOCKED_ADDRESS', HOST_NOT_PUBLIC_MESSAGE);
    }
    return { address: host, family: literal === 6 ? 6 : 4 };
  }

  let records: ResolvedAddress[];
  try {
    records = await resolveAll(host);
  } catch {
    throw new UrlImportError('DNS_FAILED', HOST_NOT_PUBLIC_MESSAGE);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new UrlImportError('DNS_FAILED', HOST_NOT_PUBLIC_MESSAGE);
  }
  if (records.some(r => isBlockedAddress(r.address))) {
    throw new UrlImportError('BLOCKED_ADDRESS', HOST_NOT_PUBLIC_MESSAGE);
  }
  return records.find(r => r.family === 4) ?? records[0];
}

// ─── Pinned connection ──────────────────────────────────────────────────────

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * A `dns.lookup`-shaped function that answers only `pinned.address`, and only
 * for `expectedHost`. Node's socket layer calls it with `options.all === true`
 * when happy-eyeballs (`autoSelectFamily`, on by default in Node 22) is in
 * play, and without it otherwise; the two want different callback shapes.
 *
 * A request for any other hostname is an error rather than a silent answer:
 * this Agent exists for one host, and anything else reaching it is a bug.
 */
export function createPinnedLookup(expectedHost: string, pinned: ResolvedAddress) {
  const expected = expectedHost.toLowerCase();
  return function pinnedLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
    if (hostname.toLowerCase() !== expected) {
      const err: NodeJS.ErrnoException = new Error(
        `Refusing to resolve unexpected host ${hostname}`
      );
      err.code = 'ENOTFOUND';
      process.nextTick(callback, err, '', 0);
      return;
    }
    if (options && options.all) {
      process.nextTick(callback, null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      process.nextTick(callback, null, pinned.address, pinned.family);
    }
  };
}

/**
 * An undici Agent whose every connection goes to `pinned.address`. Only
 * resolution is replaced: undici still passes the URL's hostname as `host`
 * (and derives SNI from it), so certificate verification is against the
 * real name. Node never calls `lookup` for a literal-IP host, which is why
 * literal IPs are validated before this Agent is built.
 */
export function createPinnedAgent(
  hostname: string,
  pinned: ResolvedAddress,
  timeouts: { connectTimeoutMs: number; headersTimeoutMs: number; bodyIdleTimeoutMs: number }
): Agent {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(hostname, pinned),
      timeout: timeouts.connectTimeoutMs,
    },
    headersTimeout: timeouts.headersTimeoutMs,
    bodyTimeout: timeouts.bodyIdleTimeoutMs,
    // One request per Agent; nothing to keep alive for.
    pipelining: 0,
  });
}

// ─── Response helpers ───────────────────────────────────────────────────────

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const v = headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const MAX_FILENAME_LENGTH = 255;

/**
 * Make a server- or URL-supplied name safe to use as a display filename:
 * last path component only (no `../`), no control characters, bounded
 * length. Returns null when nothing usable is left.
 */
function sanitizeFilename(name: string): string | null {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (clean === '' || clean === '.' || clean === '..') return null;
  return clean.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Filename from a `Content-Disposition` header. RFC 6266: `filename*`
 * (RFC 8187 `charset'lang'pct-encoded`) wins over `filename`, which may be a
 * quoted string or a bare token.
 */
export function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
      const name = sanitizeFilename(decoded);
      if (name) return name;
    } catch {
      // Malformed percent-encoding: fall through to plain `filename`.
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
  if (quoted) return sanitizeFilename(quoted[1].replace(/\\(.)/g, '$1'));
  const token = /(?:^|;)\s*filename\s*=\s*([^;\s]+)/i.exec(value);
  if (token) return sanitizeFilename(token[1]);
  return null;
}

function filenameFromUrl(url: URL): string | null {
  const segment = url.pathname.split('/').pop() ?? '';
  if (segment === '') return null;
  try {
    return sanitizeFilename(decodeURIComponent(segment));
  } catch {
    return sanitizeFilename(segment);
  }
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

export interface SafeFetchResult {
  /**
   * The response body. Yields at most `maxBytes` in total: the chunk that
   * would cross the cap is never yielded — iteration throws
   * `UrlImportError('TOO_LARGE')` instead and the connection is torn down.
   * Also throws `TIMEOUT` / `FETCH_FAILED` mid-stream. Iterate it once.
   */
  body: AsyncIterable<Uint8Array>;
  /** Declared `Content-Length`, when present and well-formed. Not trusted for the cap. */
  contentLength: number | null;
  /** Media type from `Content-Type`, lowercased, parameters stripped (`text/html`). */
  contentType: string | null;
  /** From `Content-Disposition`, else the URL's last path segment; sanitised. */
  filename: string | null;
  /** The URL actually fetched (normalised). */
  url: string;
  /** Abort the body and release the connection. Safe to call more than once. */
  cancel(): Promise<void>;
}

export interface FetchImportUrlOptions {
  /** Hard cap on body bytes. Positive integer. */
  maxBytes: number;
  /** Connect and response-headers timeout. Default 15 s. */
  headersTimeoutMs?: number;
  /** Longest silence between body chunks. Default 60 s. */
  bodyIdleTimeoutMs?: number;
  /** Deadline for the whole import, DNS through last byte. Default 10 min. */
  totalTimeoutMs?: number;
  /** DNS seam; defaults to getaddrinfo (`dns.lookup` with `all: true`). */
  resolveAll?: ResolveAll;
  /**
   * TEST ONLY. Replaces the pinned Agent (e.g. with undici's `MockAgent`).
   * Refused unless running under Vitest, so it cannot bypass the address pin
   * in production.
   */
  __testOnlyDispatcher?: Dispatcher;
}

const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60_000;

/** Map a transport-level error to our codes. `deadline` wins: an abort we caused is a timeout. */
function toImportError(err: unknown, deadline: AbortSignal): UrlImportError {
  if (err instanceof UrlImportError) return err;
  if (deadline.aborted) {
    return new UrlImportError('TIMEOUT', 'The download did not finish within the time limit.');
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return new UrlImportError('TIMEOUT', 'The server took too long to respond.');
  }
  return new UrlImportError('FETCH_FAILED', 'Could not download from that URL.');
}

/**
 * Fetch `raw` under every rule in this file's header and return the body as
 * a cap-enforced stream. Throws `UrlImportError` for every refusal made
 * before the body starts; the body itself throws for anything after.
 *
 * The caller owns the result: iterate `body` to completion (which releases
 * the connection) or call `cancel()`.
 */
export async function fetchImportUrl(
  raw: string,
  opts: FetchImportUrlOptions
): Promise<SafeFetchResult> {
  const { maxBytes } = opts;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('fetchImportUrl: maxBytes must be a positive integer');
  }
  if (opts.__testOnlyDispatcher && process.env.VITEST !== 'true') {
    throw new Error('fetchImportUrl: __testOnlyDispatcher is only available under test');
  }
  const headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const bodyIdleTimeoutMs = opts.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  const url = parseImportUrl(raw);

  // One deadline for the whole import. Our own controller rather than
  // `AbortSignal.timeout` so the timer can be cleared the moment we finish,
  // and so `toImportError` can tell "we aborted" from any other failure.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), totalTimeoutMs);
  timer.unref?.();

  let agent: Agent | null = null;
  let body: Dispatcher.ResponseData['body'] | null = null;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    try {
      body?.destroy();
    } catch {
      // already destroyed
    }
    // `destroy`, not `close`: close waits for in-flight requests, and the
    // point of releasing is usually that we are abandoning one.
    await agent?.destroy().catch(() => {});
  };

  try {
    // DNS can hang; keep it under the deadline too.
    const pinned = await new Promise<ResolvedAddress>((resolve, reject) => {
      const onAbort = () => reject(toImportError(null, deadline.signal));
      deadline.signal.addEventListener('abort', onAbort, { once: true });
      resolvePublicAddress(url.hostname, opts.resolveAll).then(
        v => {
          deadline.signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        e => {
          deadline.signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });

    let dispatcher: Dispatcher;
    if (opts.__testOnlyDispatcher) {
      dispatcher = opts.__testOnlyDispatcher;
    } else {
      agent = createPinnedAgent(url.hostname, pinned, {
        connectTimeoutMs: headersTimeoutMs,
        headersTimeoutMs,
        bodyIdleTimeoutMs,
      });
      dispatcher = agent;
    }

    let res: Dispatcher.ResponseData;
    try {
      res = await request(url, {
        method: 'GET',
        dispatcher,
        signal: deadline.signal,
        // Deliberately minimal: no cookies, no Authorization, nothing of
        // ours. `identity` so the bytes we count are the bytes we store.
        headers: {
          'user-agent': 'Classmoji-Import/1.0',
          accept: '*/*',
          'accept-encoding': 'identity',
        },
      });
    } catch (err) {
      throw toImportError(err, deadline.signal);
    }
    body = res.body;

    const status = res.statusCode;
    if (status >= 300 && status < 400) {
      const location = header(res.headers, 'location');
      let target = '';
      if (location) {
        try {
          target = ` to ${new URL(location, url).toString().slice(0, 500)}`;
        } catch {
          // unparseable Location: say nothing about it
        }
      }
      throw new UrlImportError(
        'REDIRECT_REFUSED',
        `The URL redirects${target} (HTTP ${status}). Redirects are not followed; pass the final URL instead.`,
        status
      );
    }
    if (status < 200 || status >= 300) {
      throw new UrlImportError('HTTP_ERROR', `The server answered HTTP ${status}.`, status);
    }

    // Stored byte for byte, so a compressed body would be stored compressed —
    // and the cap would count the compressed size. We asked for `identity`;
    // a server that compresses anyway is refused rather than trusted. No header
    // means identity.
    const encoding = header(res.headers, 'content-encoding')?.trim().toLowerCase() ?? '';
    if (encoding !== '' && encoding !== 'identity') {
      const named = encoding.replace(/[^a-z0-9,\s-]/g, '').slice(0, 40);
      throw new UrlImportError(
        'UNSUPPORTED_ENCODING',
        `The server sent the file compressed (${named}); only uncompressed downloads can be imported.`
      );
    }

    const lengthHeader = header(res.headers, 'content-length');
    const contentLength =
      lengthHeader && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader.trim()) : null;
    if (contentLength !== null && contentLength > maxBytes) {
      throw new UrlImportError(
        'TOO_LARGE',
        `The file is ${contentLength} bytes, over the ${maxBytes}-byte limit.`
      );
    }

    const typeHeader = header(res.headers, 'content-type');
    const contentType = typeHeader ? typeHeader.split(';')[0].trim().toLowerCase() || null : null;
    const filename =
      filenameFromContentDisposition(header(res.headers, 'content-disposition')) ??
      filenameFromUrl(url);

    const source = res.body;
    const capped = async function* (): AsyncGenerator<Uint8Array> {
      let total = 0;
      try {
        for await (const chunk of source) {
          const bytes: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += bytes.byteLength;
          // Checked BEFORE yielding: the chunk that crosses the cap never
          // reaches the consumer, whatever Content-Length said.
          if (total > maxBytes) {
            throw new UrlImportError('TOO_LARGE', `The file exceeds the ${maxBytes}-byte limit.`);
          }
          yield bytes;
        }
      } catch (err) {
        throw toImportError(err, deadline.signal);
      } finally {
        // Runs on completion, on error, and when the consumer stops early.
        await release();
      }
    };

    return {
      body: capped(),
      contentLength,
      contentType,
      filename,
      url: url.toString(),
      cancel: release,
    };
  } catch (err) {
    await release();
    throw toImportError(err, deadline.signal);
  }
}
