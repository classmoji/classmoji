import { graceFor, nowSeconds } from './bucket.ts';
import {
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

function parseBlob(url: URL, classroomId: string, segments: string[]): ParseResult {
  if (segments.length !== 4) return fail('malformed');

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

  const value: ParsedBlobUrl = { kind: 'blob', classroomId, sha, ext, ...policy };
  if (transform) value.transform = transform;
  return { ok: true, value };
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
    for (const char of part) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }
    decoded.push(part);
  }

  if (decoded.length === 0) return '';
  return decoded.join('/') + (trailingSlash ? '/' : '');
}

function parseTheme(classroomId: string, segments: string[]): ParseResult {
  if (segments.length < 6) return fail('malformed');

  const theme = decodeSegment(segments[3]);
  if (theme === null || !isTheme(theme)) return fail('malformed');

  const treeSha = segments[4];
  if (!isGitSha(treeSha)) return fail('malformed');

  const parts = segments[5].split('.');
  if (parts.length !== 4) return fail('malformed');
  const policy = readPolicy(parts[0], parts[1], parts[2], parts[3]);
  if (!policy) return fail('malformed');

  const relPath = parseRelPath(segments.slice(6));
  if (relPath === null) return fail('malformed');

  const value: ParsedThemeUrl = { kind: 'theme', classroomId, theme, treeSha, ...policy, relPath };
  return { ok: true, value };
}

function parseInternal(url: string | URL): ParseResult {
  const parsedUrl = toUrl(url);
  if (!parsedUrl) return fail('malformed');

  const segments = parsedUrl.pathname.split('/');
  if (segments.shift() !== '') return fail('malformed');
  if (segments.length < 3) return fail('malformed');

  const scheme = segments[0];
  if (!(scheme in SCHEME_SEGMENTS)) {
    return fail(SCHEME_SEGMENT_PATTERN.test(scheme) ? 'unsupported-version' : 'malformed');
  }

  const classroomId = segments[1];
  if (!isClassroomId(classroomId)) return fail('malformed');

  if (segments[2] === 'blob') return parseBlob(parsedUrl, classroomId, segments);
  if (segments[2] === 'theme') return parseTheme(classroomId, segments);
  return fail('malformed');
}

/**
 * Structural parse only — no key material, no signature check. Returns null on
 * anything that is not a well-formed content URL of a supported version.
 */
export function parseContentUrl(url: string | URL): ParsedContentUrl | null {
  const result = parseInternal(url);
  return result.ok ? result.value : null;
}

/** null when the signature is still within its tier's grace window. */
function expiryFailure(tier: Tier, exp: number, now: number): { inGrace: boolean } | null {
  const seconds = Math.floor(now);
  if (seconds <= exp) return { inGrace: false };
  if (seconds <= exp + graceFor(tier)) return { inGrace: true };
  return null;
}

async function checkSignature(
  master: string,
  parsed: ParsedContentUrl,
  canonical: string,
  signature: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  const key = await deriveKey(master, parsed.classroomId, parsed.keyVersion);
  return verifyCanonical(key, signature, canonical);
}

async function verifyParsedBlob(
  master: string,
  parsed: ParsedBlobUrl,
  now: number
): Promise<BlobVerification> {
  const signature = fromBase64Url(parsed.sig);
  if (!signature) return fail('malformed');

  const canonical = blobCanonicalString({
    classroomId: parsed.classroomId,
    sha: parsed.sha,
    ext: parsed.ext,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
    transform: parsed.transform,
  });
  if (!(await checkSignature(master, parsed, canonical, signature))) return fail('bad-signature');

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
  };
  if (parsed.transform) verified.transform = parsed.transform;
  return verified;
}

async function verifyParsedTheme(
  master: string,
  parsed: ParsedThemeUrl,
  now: number
): Promise<ThemeVerification> {
  const signature = fromBase64Url(parsed.sig);
  if (!signature) return fail('malformed');

  const canonical = themeCanonicalString({
    classroomId: parsed.classroomId,
    theme: parsed.theme,
    treeSha: parsed.treeSha,
    tier: parsed.tier,
    keyVersion: parsed.keyVersion,
    exp: parsed.exp,
  });
  if (!(await checkSignature(master, parsed, canonical, signature))) return fail('bad-signature');

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
  };
}

export async function verifyBlobUrl(
  master: string,
  url: string | URL,
  now: number = nowSeconds()
): Promise<BlobVerification> {
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  if (parsed.value.kind !== 'blob') return fail('malformed');
  return verifyParsedBlob(master, parsed.value, now);
}

export async function verifyThemeUrl(
  master: string,
  url: string | URL,
  now: number = nowSeconds()
): Promise<ThemeVerification> {
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  if (parsed.value.kind !== 'theme') return fail('malformed');
  return verifyParsedTheme(master, parsed.value, now);
}

export async function verifyContentUrl(
  master: string,
  url: string | URL,
  now: number = nowSeconds()
): Promise<BlobVerification | ThemeVerification> {
  const parsed = parseInternal(url);
  if (!parsed.ok) return fail(parsed.reason);
  return parsed.value.kind === 'blob'
    ? verifyParsedBlob(master, parsed.value, now)
    : verifyParsedTheme(master, parsed.value, now);
}

/**
 * Draft URLs are never stored anywhere. Everything else is immutable for the
 * life of its signature: the content is sha-addressed and the expiry is baked
 * into the URL, so a cache entry can live exactly that long.
 */
export function cacheControlFor(tier: Tier, exp: number, now: number): string {
  if (tier === 'draft') return 'no-store';
  const maxAge = Math.max(0, Math.floor(exp) - Math.floor(now));
  return `public, max-age=${maxAge}, immutable`;
}
