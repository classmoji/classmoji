import { graceFor, nowSeconds } from './bucket.ts';
import {
  BLOB_QUERY_KEYS,
  SCHEME_SEGMENTS,
  SCHEME_SEGMENT_PATTERN,
  blobCanonicalString,
  fromBase64Url,
  isClassroomId,
  isExt,
  isGitSha,
  isKeyVersion,
  isTheme,
  isTier,
  isTransformFormat,
  isTransformWidth,
  isUnixSeconds,
  themeCanonicalString,
} from './canonical.ts';
import { deriveKey, verifyCanonical } from './derive.ts';
import type {
  BlobVerification,
  KeySlot,
  MasterSecrets,
  ParsedBlobUrl,
  ParsedContentUrl,
  ParsedThemeUrl,
  ThemeVerification,
  Tier,
  Transform,
  VerifyFailure,
} from './types.ts';

type ParseResult = { ok: true; value: ParsedContentUrl } | { ok: false; reason: VerifyFailure };

const fail = (reason: VerifyFailure): { ok: false; reason: VerifyFailure } => ({
  ok: false,
  reason,
});

/** Anything still percent-encoded after one decode. */
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

function toUrl(url: string | URL): URL | null {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Every query key must be signed and appear once. An unknown or repeated key
 * means somebody appended something the signature does not cover - and
 * `searchParams.get` would silently hand back only the first of a repeated pair.
 */
function queryKeysOk(url: URL, allowed: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
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
  if (keyVersion === null || !isKeyVersion(keyVersion)) return null;
  const exp = parseNonNegativeInt(rawExp);
  if (exp === null || !isUnixSeconds(exp)) return null;
  if (!rawSig) return null;
  return { tier: rawTier, keyVersion, exp, sig: rawSig };
}

function parseTransform(url: URL): Transform | null | undefined {
  const rawWidth = url.searchParams.get('w');
  const rawFormat = url.searchParams.get('fmt');
  if (rawWidth === null && rawFormat === null) return undefined;

  const transform: Transform = {};
  if (rawWidth !== null) {
    const width = parseNonNegativeInt(rawWidth);
    if (width === null || !isTransformWidth(width)) return null;
    transform.w = width;
  }
  if (rawFormat !== null) {
    if (!isTransformFormat(rawFormat)) return null;
    transform.fmt = rawFormat;
  }
  return transform;
}

/**
 * Decode and validate the path under a signed theme folder.
 *
 * Exported because the guarantee matters to callers that resolve these paths
 * themselves: the result is decoded exactly once, has no empty, dot, or
 * dot-dot segment, no separator or control character, and - crucially - nothing
 * still percent-encoded, so a second decode downstream cannot resurrect `../`
 * out of `%252e%252e%252f`. Returns null when the path is unusable.
 *
 * The cost is that a file whose real name contains a percent escape sequence
 * (`report%2Bdraft.png`) is refused rather than served.
 */
export function normalizeRelPath(segments: string[]): string | null {
  let rest = segments;
  // A signed theme base ends in a slash; that single empty tail is the folder.
  if (rest.length > 0 && rest[rest.length - 1] === '') rest = rest.slice(0, -1);

  const decoded: string[] = [];
  for (const segment of rest) {
    if (segment === '') return null;
    const part = decodeSegment(segment);
    if (part === null) return null;
    if (part === '' || part === '.' || part === '..') return null;
    if (PERCENT_ESCAPE.test(part)) return null;
    if (part.includes('/') || part.includes('\\')) return null;
    for (const char of part) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }
    decoded.push(part);
  }

  return decoded.join('/');
}

function parseBlob(url: URL, host: string, classroomId: string, segments: string[]): ParseResult {
  if (segments.length !== 4) return fail('malformed');
  if (!queryKeysOk(url, BLOB_QUERY_KEYS)) return fail('malformed');

  const file = decodeSegment(segments[3]);
  if (file === null) return fail('malformed');
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || dot === file.length - 1) return fail('malformed');

  const sha = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (!isGitSha(sha) || !isExt(ext)) return fail('malformed');

  const policy = readPolicy(
    url.searchParams.get('p'),
    url.searchParams.get('v'),
    url.searchParams.get('exp'),
    url.searchParams.get('sig')
  );
  if (!policy) return fail('malformed');

  const transform = parseTransform(url);
  if (transform === null) return fail('malformed');

  const value: ParsedBlobUrl = { kind: 'blob', host, classroomId, sha, ext, ...policy };
  if (transform) value.transform = transform;
  return { ok: true, value };
}

function parseTheme(url: URL, host: string, classroomId: string, segments: string[]): ParseResult {
  if (segments.length < 6) return fail('malformed');
  // Nothing in a theme URL is carried in the query, so nothing may appear there.
  if (!queryKeysOk(url, [])) return fail('malformed');

  const theme = decodeSegment(segments[3]);
  if (theme === null || !isTheme(theme)) return fail('malformed');

  const treeSha = segments[4];
  if (!isGitSha(treeSha)) return fail('malformed');

  const parts = segments[5].split('.');
  if (parts.length !== 4) return fail('malformed');
  const policy = readPolicy(parts[0], parts[1], parts[2], parts[3]);
  if (!policy) return fail('malformed');

  const relPath = normalizeRelPath(segments.slice(6));
  if (relPath === null) return fail('malformed');

  const value: ParsedThemeUrl = {
    kind: 'theme',
    host,
    classroomId,
    theme,
    treeSha,
    ...policy,
    relPath,
  };
  return { ok: true, value };
}

function parseInternal(url: string | URL): ParseResult {
  const parsedUrl = toUrl(url);
  if (!parsedUrl) return fail('malformed');

  const host = parsedUrl.host.toLowerCase();
  if (!host) return fail('malformed');

  const segments = parsedUrl.pathname.split('/');
  if (segments.shift() !== '') return fail('malformed');
  if (segments.length < 3) return fail('malformed');

  const scheme = segments[0];
  if (!(scheme in SCHEME_SEGMENTS)) {
    return fail(SCHEME_SEGMENT_PATTERN.test(scheme) ? 'unsupported-version' : 'malformed');
  }

  const classroomId = segments[1];
  if (!isClassroomId(classroomId)) return fail('malformed');

  if (segments[2] === 'blob') return parseBlob(parsedUrl, host, classroomId, segments);
  if (segments[2] === 'theme') return parseTheme(parsedUrl, host, classroomId, segments);
  return fail('malformed');
}

/**
 * Structural parse only - no key material, no signature check. Returns null on
 * anything that is not a well-formed content URL of a supported version.
 */
export function parseContentUrl(url: string | URL): ParsedContentUrl | null {
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

/**
 * Normalize whatever the caller passed into an ordered list of usable secrets.
 *
 * Blank entries are dropped rather than tried, so a deployment can clear its
 * previous-key slot by emptying it instead of restructuring the call. Blank
 * means whitespace too: a slot cleared with a space or a stray newline must not
 * become a live master, or ` ` would be a key anyone could sign with. The
 * surviving values are kept verbatim — never trimmed — because the apps sign
 * with the exact bytes they were given.
 *
 * Nothing left to try is a programming error, not a failed verification:
 * answering `bad-signature` there would turn a misconfigured deployment into a
 * story about forged URLs.
 */
function masterList(master: MasterSecrets): readonly string[] {
  const candidates = typeof master === 'string' ? [master] : master;
  const usable = candidates.filter(entry => typeof entry === 'string' && entry.trim().length > 0);
  if (usable.length === 0) {
    throw new TypeError('content-signing: at least one master secret is required');
  }
  return usable;
}

/**
 * Try each master in order and report which one matched, or null for none.
 *
 * The current key is first, so the steady state costs exactly one derive and
 * one verify; a previous key is only reached for a URL the current key already
 * rejected. Each comparison is constant-time by construction — it happens
 * inside Web Crypto — and the loop leaks only how many keys are configured,
 * which is not a secret.
 */
async function checkSignature(
  masters: readonly string[],
  parsed: ParsedContentUrl,
  canonical: string,
  signature: Uint8Array<ArrayBuffer>
): Promise<KeySlot | null> {
  for (const [index, master] of masters.entries()) {
    const key = await deriveKey(master, parsed.classroomId, parsed.keyVersion);
    if (await verifyCanonical(key, signature, canonical)) {
      return index === 0 ? 'current' : 'previous';
    }
  }
  return null;
}

async function verifyParsedBlob(
  masters: readonly string[],
  parsed: ParsedBlobUrl,
  now: number
): Promise<BlobVerification> {
  const signature = fromBase64Url(parsed.sig);
  if (!signature) return fail('malformed');

  const canonical = blobCanonicalString({
    host: parsed.host,
    classroomId: parsed.classroomId,
    sha: parsed.sha,
    ext: parsed.ext,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
    transform: parsed.transform,
  });
  const keySlot = await checkSignature(masters, parsed, canonical, signature);
  if (!keySlot) return fail('bad-signature');

  const expiry = expiryFailure(parsed.tier, parsed.exp, now);
  if (!expiry) return fail('expired');

  const verified: BlobVerification = {
    ok: true,
    kind: 'blob',
    classroomId: parsed.classroomId,
    sha: parsed.sha,
    ext: parsed.ext,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
    inGrace: expiry.inGrace,
    keySlot,
  };
  if (parsed.transform) verified.transform = parsed.transform;
  return verified;
}

async function verifyParsedTheme(
  masters: readonly string[],
  parsed: ParsedThemeUrl,
  now: number
): Promise<ThemeVerification> {
  const signature = fromBase64Url(parsed.sig);
  if (!signature) return fail('malformed');

  const canonical = themeCanonicalString({
    host: parsed.host,
    classroomId: parsed.classroomId,
    theme: parsed.theme,
    treeSha: parsed.treeSha,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
  });
  const keySlot = await checkSignature(masters, parsed, canonical, signature);
  if (!keySlot) return fail('bad-signature');

  const expiry = expiryFailure(parsed.tier, parsed.exp, now);
  if (!expiry) return fail('expired');

  return {
    ok: true,
    kind: 'theme',
    classroomId: parsed.classroomId,
    theme: parsed.theme,
    treeSha: parsed.treeSha,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
    relPath: parsed.relPath,
    inGrace: expiry.inGrace,
    keySlot,
  };
}

/**
 * `master` is the current secret, or an ordered list with the previous one
 * after it during a rotation. The result says which slot matched, so a caller
 * can watch previous-key traffic drain before retiring that key.
 */
export async function verifyBlobUrl(
  master: MasterSecrets,
  url: string | URL,
  now: number = nowSeconds()
): Promise<BlobVerification> {
  const masters = masterList(master);
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  if (parsed.value.kind !== 'blob') return fail('malformed');
  return verifyParsedBlob(masters, parsed.value, now);
}

export async function verifyThemeUrl(
  master: MasterSecrets,
  url: string | URL,
  now: number = nowSeconds()
): Promise<ThemeVerification> {
  const masters = masterList(master);
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  if (parsed.value.kind !== 'theme') return fail('malformed');
  return verifyParsedTheme(masters, parsed.value, now);
}

export async function verifyContentUrl(
  master: MasterSecrets,
  url: string | URL,
  now: number = nowSeconds()
): Promise<BlobVerification | ThemeVerification> {
  const masters = masterList(master);
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  return parsed.value.kind === 'blob'
    ? verifyParsedBlob(masters, parsed.value, now)
    : verifyParsedTheme(masters, parsed.value, now);
}

/**
 * `edit` URLs are never stored anywhere. Everything else is immutable for the
 * life of its signature: the content is sha-addressed and the expiry is baked
 * into the URL, so a cache entry can live exactly that long.
 *
 * Past `exp` - i.e. inside grace - the URL is still being served but must not
 * be pinned as immutable, so it gets a short positive TTL instead. A zero
 * max-age would send every cache back to the origin at once.
 */
export function cacheControlFor(tier: Tier, exp: number, now: number): string {
  if (tier === 'edit') return 'no-store';
  const maxAge = Math.floor(exp) - Math.floor(now);
  if (maxAge <= 0) return 'public, max-age=60';
  return `public, max-age=${maxAge}, immutable`;
}
