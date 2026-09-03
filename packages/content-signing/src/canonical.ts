import type { Tier, Transform, TransformFormat, TransformWidth } from './types.ts';

/**
 * Canonical signing-string version. Bumping it is a breaking change to every
 * signature, so it also gets a new URL scheme segment (see SCHEME_SEGMENTS).
 */
export const CANONICAL_VERSION = 'cm1';

/**
 * First path segment -> canonical version. The version is not carried in a
 * query param because the theme shape has no query string; the scheme segment
 * is the one place both shapes share.
 */
export const SCHEME_SEGMENTS: Readonly<Record<string, string>> = { c: CANONICAL_VERSION };

/** A segment that looks like a content scheme, known or not. */
export const SCHEME_SEGMENT_PATTERN = /^c[0-9]*$/;

export const TIERS: readonly Tier[] = ['public', 'enrolled', 'draft'];
export const TRANSFORM_WIDTHS: readonly TransformWidth[] = [800, 1600, 2560];
export const TRANSFORM_FORMATS: readonly TransformFormat[] = ['webp', 'avif', 'auto'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;
const THEME_PATTERN = /^[a-z0-9._-]+$/;

export function isClassroomId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value);
}

export function isExt(value: unknown): value is string {
  return typeof value === 'string' && EXT_PATTERN.test(value);
}

export function isTheme(value: unknown): value is string {
  return typeof value === 'string' && THEME_PATTERN.test(value);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

export function isTransformWidth(value: unknown): value is TransformWidth {
  return typeof value === 'number' && (TRANSFORM_WIDTHS as readonly number[]).includes(value);
}

export function isTransformFormat(value: unknown): value is TransformFormat {
  return typeof value === 'string' && (TRANSFORM_FORMATS as readonly string[]).includes(value);
}

export function isUnixSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isKeyVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new TypeError(message);
}

export function assertClassroomId(value: string): void {
  assert(
    isClassroomId(value),
    `content-signing: classroomId must be a lowercase UUID (got ${value})`
  );
}

export function assertTier(value: Tier): void {
  assert(isTier(value), `content-signing: unknown tier (got ${value})`);
}

export function assertKeyVersion(value: number): void {
  assert(isKeyVersion(value), `content-signing: keyVersion must be a non-negative integer`);
}

export function assertTransform(transform: Transform | undefined): void {
  if (!transform) return;
  if (transform.w !== undefined) {
    assert(isTransformWidth(transform.w), `content-signing: unsupported width ${transform.w}`);
  }
  if (transform.fmt !== undefined) {
    assert(
      isTransformFormat(transform.fmt),
      `content-signing: unsupported format ${transform.fmt}`
    );
  }
}

export interface BlobCanonicalFields {
  classroomId: string;
  sha: string;
  ext: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  transform?: Transform;
}

export interface ThemeCanonicalFields {
  classroomId: string;
  theme: string;
  treeSha: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
}

/** `cm1|blob|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}` */
export function blobCanonicalString(fields: BlobCanonicalFields): string {
  const { classroomId, sha, ext, tier, keyVersion, exp, transform } = fields;
  const w = transform?.w === undefined ? '' : String(transform.w);
  const fmt = transform?.fmt ?? '';
  return [CANONICAL_VERSION, 'blob', classroomId, sha, ext, tier, keyVersion, exp, w, fmt].join(
    '|'
  );
}

/** `cm1|theme|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}` */
export function themeCanonicalString(fields: ThemeCanonicalFields): string {
  const { classroomId, theme, treeSha, tier, keyVersion, exp } = fields;
  return [CANONICAL_VERSION, 'theme', classroomId, theme, treeSha, tier, keyVersion, exp].join('|');
}

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

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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
