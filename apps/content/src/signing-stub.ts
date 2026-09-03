/**
 * LOCAL STUB for `@classmoji/content-signing`.
 *
 * The real package lives on its own branch and is not in this tree yet. This
 * file mirrors its public contract exactly — same names, same units, same
 * validation — so the Worker is buildable and testable now, and so a URL minted
 * by the real package verifies identically here.
 *
 * SWAP: `src/verify.ts` is the only module that imports this file. See the note
 * there. Delete this file once the swap is confirmed to bundle under wrangler.
 *
 * Canonical strings (HMAC-SHA256, base64url, no padding):
 *   key   = HMAC-SHA256(MASTER, `${classroomId}|${keyVersion}`)
 *   blob    `cm1|blob|{host}|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}`
 *   theme   `cm1|theme|{host}|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}`
 *
 * `host` is the lowercased request host, port included, so a signature minted
 * for one delivery origin cannot be replayed against another.
 *
 * All times are unix SECONDS. Web Crypto only — no Node built-ins.
 */

export type Tier = 'public' | 'enrolled' | 'draft';
export type TransformWidth = 800 | 1600 | 2560;
export type TransformFormat = 'webp' | 'avif' | 'auto';

export interface Transform {
  w?: TransformWidth;
  fmt?: TransformFormat;
}

export type VerifyFailure = 'malformed' | 'bad-signature' | 'expired' | 'unsupported-version';

export type BlobVerification =
  | {
      ok: true;
      kind: 'blob';
      classroomId: string;
      sha: string;
      ext: string;
      tier: Tier;
      keyVersion: number;
      exp: number;
      transform?: Transform;
      inGrace: boolean;
    }
  | { ok: false; reason: VerifyFailure };

export type ThemeVerification =
  | {
      ok: true;
      kind: 'theme';
      classroomId: string;
      theme: string;
      treeSha: string;
      tier: Tier;
      keyVersion: number;
      exp: number;
      relPath: string;
      inGrace: boolean;
    }
  | { ok: false; reason: VerifyFailure };

export const CANONICAL_VERSION = 'cm1';

/** First path segment -> canonical version. The scheme segment IS the version marker. */
export const SCHEME_SEGMENTS: Readonly<Record<string, string>> = { c: CANONICAL_VERSION };

/** A segment that looks like a content scheme, known or not. */
const SCHEME_SEGMENT_PATTERN = /^c[0-9]*$/;

export const TIERS: readonly Tier[] = ['public', 'enrolled', 'draft'];
export const TRANSFORM_WIDTHS: readonly TransformWidth[] = [800, 1600, 2560];
export const TRANSFORM_FORMATS: readonly TransformFormat[] = ['webp', 'avif', 'auto'];

const HOUR = 3600;
const DAY = 86400;

export interface TierPolicy {
  bucketSeconds: number | null;
  ttlSeconds: number | null;
  graceSeconds: number;
}

export const TIER_POLICY: Readonly<Record<Tier, TierPolicy>> = {
  public: { bucketSeconds: 30 * DAY, ttlSeconds: null, graceSeconds: 6 * HOUR },
  enrolled: { bucketSeconds: 7 * DAY, ttlSeconds: null, graceSeconds: 6 * HOUR },
  draft: { bucketSeconds: null, ttlSeconds: 4 * HOUR, graceSeconds: 5 * 60 },
};

export function graceFor(tier: Tier): number {
  return TIER_POLICY[tier].graceSeconds;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;
const THEME_PATTERN = /^[a-z0-9._-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();

/** TextEncoder always allocates a plain ArrayBuffer, never a shared one. */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null rather than throwing: callers turn that into 'malformed'. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

interface BlobCanonicalFields {
  host: string;
  classroomId: string;
  sha: string;
  ext: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  transform?: Transform;
}

interface ThemeCanonicalFields {
  host: string;
  classroomId: string;
  theme: string;
  treeSha: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
}

export function blobCanonicalString(fields: BlobCanonicalFields): string {
  const { host, classroomId, sha, ext, tier, keyVersion, exp, transform } = fields;
  const w = transform?.w === undefined ? '' : String(transform.w);
  const fmt = transform?.fmt ?? '';
  return [
    CANONICAL_VERSION,
    'blob',
    host,
    classroomId,
    sha,
    ext,
    tier,
    keyVersion,
    exp,
    w,
    fmt,
  ].join('|');
}

export function themeCanonicalString(fields: ThemeCanonicalFields): string {
  const { host, classroomId, theme, treeSha, tier, keyVersion, exp } = fields;
  return [
    CANONICAL_VERSION,
    'theme',
    host,
    classroomId,
    theme,
    treeSha,
    tier,
    keyVersion,
    exp,
  ].join('|');
}

const HMAC_PARAMS = { name: 'HMAC', hash: 'SHA-256' } as const;

function subtle(): SubtleCrypto {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoRef?.subtle) {
    throw new Error('content-signing: Web Crypto (globalThis.crypto.subtle) is unavailable');
  }
  return cryptoRef.subtle;
}

async function importRawKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey('raw', bytes, HMAC_PARAMS, false, ['sign', 'verify']);
}

/** Per-classroom key: `HMAC-SHA256(master, classroomId + '|' + keyVersion)`. */
export async function deriveKey(
  master: string,
  classroomId: string,
  keyVersion: number
): Promise<CryptoKey> {
  if (typeof master !== 'string' || master.length === 0) {
    throw new TypeError('content-signing: master secret must be a non-empty string');
  }
  const masterKey = await importRawKey(utf8(master));
  const material = await subtle().sign('HMAC', masterKey, utf8(`${classroomId}|${keyVersion}`));
  return importRawKey(new Uint8Array(material) as Uint8Array<ArrayBuffer>);
}

export async function signCanonical(key: CryptoKey, canonical: string): Promise<ArrayBuffer> {
  return subtle().sign('HMAC', key, utf8(canonical));
}

/** Constant-time by construction: the comparison happens inside Web Crypto. */
export async function verifyCanonical(
  key: CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  canonical: string
): Promise<boolean> {
  return subtle().verify('HMAC', key, signature, utf8(canonical));
}

const fail = (reason: VerifyFailure): { ok: false; reason: VerifyFailure } => ({
  ok: false,
  reason,
});

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

interface PolicyFields {
  tier: Tier;
  keyVersion: number;
  exp: number;
  sig: string;
}

function readPolicy(
  rawTier: string | null,
  rawVersion: string | null,
  rawExp: string | null,
  rawSig: string | null
): PolicyFields | null {
  if (!isTier(rawTier)) return null;
  const keyVersion = parseNonNegativeInt(rawVersion);
  if (keyVersion === null) return null;
  const exp = parseNonNegativeInt(rawExp);
  if (exp === null) return null;
  if (!rawSig) return null;
  return { tier: rawTier, keyVersion, exp, sig: rawSig };
}

/** Blob URLs carry exactly these params. Anything else — or a repeat — is malformed. */
const BLOB_QUERY_KEYS: readonly string[] = ['p', 'v', 'exp', 'sig', 'w', 'fmt'];

function hasOnlyAllowedQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  return keys.every(key => BLOB_QUERY_KEYS.includes(key));
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parseTransform(url: URL): Transform | null | undefined {
  const rawWidth = url.searchParams.get('w');
  const rawFormat = url.searchParams.get('fmt');
  if (rawWidth === null && rawFormat === null) return undefined;

  const transform: Transform = {};
  if (rawWidth !== null) {
    const width = parseNonNegativeInt(rawWidth);
    if (width === null || !(TRANSFORM_WIDTHS as readonly number[]).includes(width)) return null;
    transform.w = width as TransformWidth;
  }
  if (rawFormat !== null) {
    if (!(TRANSFORM_FORMATS as readonly string[]).includes(rawFormat)) return null;
    transform.fmt = rawFormat as TransformFormat;
  }
  return transform;
}

function parseRelPath(segments: string[]): string | null {
  let rest = segments;
  let trailingSlash = false;
  if (rest.length > 0 && rest[rest.length - 1] === '') {
    rest = rest.slice(0, -1);
    trailingSlash = true;
  }

  const decoded: string[] = [];
  for (const segment of rest) {
    if (segment === '') return null;
    const part = decodeSegment(segment);
    if (part === null) return null;
    if (part === '.' || part === '..') return null;
    // A decoded separator would let an encoded '..' slip past the checks above.
    if (part.includes('/') || part.includes('\\')) return null;
    // Still encoded after one decode means a double encoding — refuse rather
    // than guess how many rounds the origin will apply.
    if (/%[0-9A-Fa-f]{2}/.test(part)) return null;
    for (const char of part) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }
    decoded.push(part);
  }

  if (decoded.length === 0) return '';
  return decoded.join('/') + (trailingSlash ? '/' : '');
}

type ParsedBlob = {
  kind: 'blob';
  host: string;
  classroomId: string;
  sha: string;
  ext: string;
  transform?: Transform;
} & PolicyFields;
type ParsedTheme = {
  kind: 'theme';
  host: string;
  classroomId: string;
  theme: string;
  treeSha: string;
  relPath: string;
} & PolicyFields;
type Parsed = ParsedBlob | ParsedTheme;
type ParseResult = { ok: true; value: Parsed } | { ok: false; reason: VerifyFailure };

function parseInternal(url: string | URL): ParseResult {
  let parsedUrl: URL;
  try {
    parsedUrl = url instanceof URL ? url : new URL(url);
  } catch {
    return fail('malformed');
  }

  const host = parsedUrl.host.toLowerCase();
  const segments = parsedUrl.pathname.split('/');
  if (segments.shift() !== '') return fail('malformed');
  if (segments.length < 3) return fail('malformed');

  const scheme = segments[0];
  if (!(scheme in SCHEME_SEGMENTS)) {
    return fail(SCHEME_SEGMENT_PATTERN.test(scheme) ? 'unsupported-version' : 'malformed');
  }

  const classroomId = segments[1];
  if (!UUID_PATTERN.test(classroomId)) return fail('malformed');

  if (segments[2] === 'blob') {
    if (segments.length !== 4) return fail('malformed');
    if (!hasOnlyAllowedQuery(parsedUrl)) return fail('malformed');
    const file = decodeSegment(segments[3]);
    if (file === null) return fail('malformed');
    const dot = file.lastIndexOf('.');
    if (dot <= 0 || dot === file.length - 1) return fail('malformed');

    const sha = file.slice(0, dot);
    const ext = file.slice(dot + 1);
    if (!GIT_SHA_PATTERN.test(sha) || !EXT_PATTERN.test(ext)) return fail('malformed');

    const policy = readPolicy(
      parsedUrl.searchParams.get('p'),
      parsedUrl.searchParams.get('v'),
      parsedUrl.searchParams.get('exp'),
      parsedUrl.searchParams.get('sig')
    );
    if (!policy) return fail('malformed');

    const transform = parseTransform(parsedUrl);
    if (transform === null) return fail('malformed');

    const value: ParsedBlob = { kind: 'blob', host, classroomId, sha, ext, ...policy };
    if (transform) value.transform = transform;
    return { ok: true, value };
  }

  if (segments[2] === 'theme') {
    if (segments.length < 6) return fail('malformed');
    // The theme shape has no query string at all; anything there is tampering.
    if (parsedUrl.search !== '') return fail('malformed');

    const theme = decodeSegment(segments[3]);
    if (theme === null || !THEME_PATTERN.test(theme)) return fail('malformed');

    const treeSha = segments[4];
    if (!GIT_SHA_PATTERN.test(treeSha)) return fail('malformed');

    const parts = segments[5].split('.');
    if (parts.length !== 4) return fail('malformed');
    const policy = readPolicy(parts[0], parts[1], parts[2], parts[3]);
    if (!policy) return fail('malformed');

    const relPath = parseRelPath(segments.slice(6));
    if (relPath === null) return fail('malformed');

    return {
      ok: true,
      value: { kind: 'theme', host, classroomId, theme, treeSha, ...policy, relPath },
    };
  }

  return fail('malformed');
}

/** Structural parse only — no key material, no signature check. */
export function parseContentUrl(url: string | URL): Parsed | null {
  const result = parseInternal(url);
  return result.ok ? result.value : null;
}

/** null when the signature is past its tier's grace window. */
function expiryFailure(tier: Tier, exp: number, now: number): { inGrace: boolean } | null {
  const seconds = Math.floor(now);
  if (seconds <= exp) return { inGrace: false };
  if (seconds <= exp + graceFor(tier)) return { inGrace: true };
  return null;
}

async function checkSignature(master: string, parsed: Parsed, canonical: string): Promise<boolean> {
  const signature = fromBase64Url(parsed.sig);
  if (!signature) return false;
  const key = await deriveKey(master, parsed.classroomId, parsed.keyVersion);
  return verifyCanonical(key, signature, canonical);
}

/** `now` is unix SECONDS. */
export async function verifyContentUrl(
  master: string,
  url: string | URL,
  now: number = nowSeconds()
): Promise<BlobVerification | ThemeVerification> {
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);

  const value = parsed.value;
  const canonical =
    value.kind === 'blob' ? blobCanonicalString(value) : themeCanonicalString(value);

  if (!(await checkSignature(master, value, canonical))) return fail('bad-signature');

  const expiry = expiryFailure(value.tier, value.exp, now);
  if (!expiry) return fail('expired');

  if (value.kind === 'blob') {
    const verified: BlobVerification = {
      ok: true,
      kind: 'blob',
      classroomId: value.classroomId,
      sha: value.sha,
      ext: value.ext,
      tier: value.tier,
      keyVersion: value.keyVersion,
      exp: value.exp,
      inGrace: expiry.inGrace,
    };
    if (value.transform) verified.transform = value.transform;
    return verified;
  }

  return {
    ok: true,
    kind: 'theme',
    classroomId: value.classroomId,
    theme: value.theme,
    treeSha: value.treeSha,
    tier: value.tier,
    keyVersion: value.keyVersion,
    exp: value.exp,
    relPath: value.relPath,
    inGrace: expiry.inGrace,
  };
}

/**
 * Draft URLs are never stored anywhere. Everything else is immutable for the
 * life of its signature. `exp` and `now` are unix SECONDS.
 */
export function cacheControlFor(tier: Tier, exp: number, now: number): string {
  if (tier === 'draft') return 'no-store';
  const maxAge = Math.max(0, Math.floor(exp) - Math.floor(now));
  return `public, max-age=${maxAge}, immutable`;
}
