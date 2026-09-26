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

/** Every tier, shortest lifetime first. See `Tier` in types.ts. */
export const TIERS: readonly Tier[] = ['download', 'edit', 'week', 'month'];
export const TRANSFORM_WIDTHS: readonly TransformWidth[] = [800, 1600, 2560];
export const TRANSFORM_FORMATS: readonly TransformFormat[] = ['webp', 'avif', 'auto'];

/** Query keys a blob URL may carry. Anything else is unsigned, so it is refused. */
export const BLOB_QUERY_KEYS: readonly string[] = ['p', 'v', 'exp', 'sig', 'w', 'fmt', 'dl'];

/**
 * Query keys a media URL may carry.
 *
 * No `w` and no `fmt`: a media object is a video, an audio file or a document,
 * and the image pipeline never sees one. A media URL carrying either is
 * refused rather than ignored — an unsigned param is what tampering looks like.
 */
export const MEDIA_QUERY_KEYS: readonly string[] = ['p', 'v', 'exp', 'sig', 'dl'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;
// Leading dots are excluded so a theme can never name a dotfile directory.
const THEME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/**
 * The three objects one media upload can produce: the original as it was
 * uploaded, the streaming rendition, and the poster frame.
 *
 * A closed list rather than a grammar with a free filename, because this string
 * is BOTH a URL segment and the tail of an R2 key. Nothing here can hold a
 * slash, a dot segment or an escape, so `mediaKey` cannot be talked into
 * addressing an object outside `m/{classroom}/{media}/`.
 */
const MEDIA_VARIANT_PATTERN = /^(?:orig\.[a-z0-9]{1,8}|web\.mp4|poster\.webp)$/;

/** A lowercase RFC-4122 UUID. Classroom ids and slide ids are the same shape. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isClassroomId(value: unknown): value is string {
  return isUuid(value);
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

/** A media object's id. Same shape as a classroom id — both are row uuids. */
export function isMediaId(value: unknown): value is string {
  return isUuid(value);
}

export function isMediaVariant(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_VARIANT_PATTERN.test(value);
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isKeyVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

export function assertMediaId(value: string): void {
  assert(isMediaId(value), `content-signing: mediaId must be a lowercase UUID (got ${value})`);
}

export function assertMediaVariant(value: string): void {
  assert(
    isMediaVariant(value),
    `content-signing: variant must be orig.{ext}, web.mp4 or poster.webp (got ${value})`
  );
}

export function assertKeyVersion(value: number): void {
  assert(
    isKeyVersion(value),
    `content-signing: keyVersion must be a non-negative safe integer (got ${value})`
  );
}

/** Mint-side guard: a NaN or fractional clock would sign an expiry nobody can verify. */
export function assertNow(value: number): void {
  assert(
    isUnixSeconds(value),
    `content-signing: now must be a non-negative integer of unix seconds (got ${value})`
  );
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

/**
 * Host a URL is bound to: lowercased, port included. Signatures cover it, so a
 * URL minted for one host cannot be replayed against another.
 *
 * Scheme is deliberately NOT covered - http and https on the same host share a
 * signature.
 */
export function hostOf(origin: string | URL): string {
  if (origin instanceof URL) return origin.host.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`content-signing: origin must be an absolute URL (got ${origin})`);
  }
  if (!parsed.host) {
    throw new TypeError(`content-signing: origin must carry a host (got ${origin})`);
  }
  return parsed.host.toLowerCase();
}

export interface BlobCanonicalFields {
  host: string;
  classroomId: string;
  sha: string;
  ext: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  transform?: Transform;
  /**
   * The ENCODED (base64url) download filename, or undefined when the URL is not
   * a download. Never the raw name: the verifier holds only what arrived in the
   * query, and it must be able to build this string before it decodes anything.
   */
  dl?: string;
}

export interface MediaCanonicalFields {
  host: string;
  classroomId: string;
  mediaId: string;
  variant: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  /** The ENCODED (base64url) download filename. See `BlobCanonicalFields.dl`. */
  dl?: string;
}

export interface ThemeCanonicalFields {
  host: string;
  classroomId: string;
  theme: string;
  treeSha: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
}

/**
 * `cm1|blob|{host}|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}`
 * and, ONLY for a download URL, `|dl|{dl}` appended to it.
 *
 * The suffix is appended rather than slotted in as a twelfth field, and that is
 * the whole design: a URL with no `dl` must produce the string it produced
 * before downloads existed — eleven fields, no trailing pipe — or every
 * signature already in a browser, a cache, or a rendered page stops verifying.
 * The `dl` marker inside the suffix keeps the two namespaces apart, so a
 * downloadless URL can never collide with a download one.
 */
export function blobCanonicalString(fields: BlobCanonicalFields): string {
  const { host, classroomId, sha, ext, tier, keyVersion, exp, transform, dl } = fields;
  const w = transform?.w === undefined ? '' : String(transform.w);
  const fmt = transform?.fmt ?? '';
  const base = [
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
  return dl === undefined ? base : `${base}|dl|${dl}`;
}

/**
 * `cm1|media|{host}|{classroomId}|{mediaId}|{variant}|{p}|{v}|{exp}`
 * and, ONLY for a download URL, `|dl|{dl}` appended to it.
 *
 * The blob shape with its path swapped, minus the two transform slots: media is
 * never resized or re-encoded on the way out, so a `w`/`fmt` pair could only
 * ever be empty and a field that is always empty is a field that means nothing.
 * The discriminator is what keeps the namespaces apart — `media` here, `blob`
 * there — so no media URL can be replayed as a blob one, or the reverse, even
 * for the same classroom and key version.
 *
 * Every field is validated before it reaches this string (uuid, closed variant
 * list, tier, integers), so none of them can carry the `|` that separates them.
 */
export function mediaCanonicalString(fields: MediaCanonicalFields): string {
  const { host, classroomId, mediaId, variant, tier, keyVersion, exp, dl } = fields;
  const base = [
    CANONICAL_VERSION,
    'media',
    host,
    classroomId,
    mediaId,
    variant,
    tier,
    keyVersion,
    exp,
  ].join('|');
  return dl === undefined ? base : `${base}|dl|${dl}`;
}

/**
 * Where one media variant lives in the media bucket: `m/{classroomId}/{mediaId}/{variant}`.
 *
 * Classroom-scoped and NOT content-addressed, unlike `blobKey` in the Worker.
 * Two classrooms holding the same video hold two objects, because the quota has
 * to be answerable per classroom and a delete must not reach into another one.
 *
 * It lives in this package because the app writes these keys and the Worker
 * reads them, and a disagreement about the shape would be a 404 nobody can see
 * the cause of. Inputs are asserted rather than trusted: this is a storage
 * address built from values that arrived over the network.
 */
export function mediaKey(classroomId: string, mediaId: string, variant: string): string {
  assertClassroomId(classroomId);
  assertMediaId(mediaId);
  assertMediaVariant(variant);
  return `m/${classroomId}/${mediaId}/${variant}`;
}

export interface RenderCanonicalFields {
  host: string;
  classroomId: string;
  slideId: string;
  exp: number;
}

/**
 * `cm1|render|{host}|{classroomId}|{slideId}|{exp}`
 *
 * A DISTINCT discriminator from `blob` and `theme`, and that is the whole
 * point: a render token authorises a headless browser to read ONE deck's first
 * slide for two minutes, and it must not be usable — nor mistakeable — as a
 * content URL. The namespaces cannot collide because the second field differs,
 * and every verifier covers the whole canonical string.
 *
 * No tier and no key version in here. The lifetime is an exact TTL rather than
 * a bucket (120 seconds, no grace), and the key version is not carried in the
 * token at all: the verifier derives with the classroom's CURRENT version, so
 * bumping `content_key_version` retires a classroom's render tokens exactly as
 * it retires its signed asset URLs.
 */
export function renderCanonicalString(fields: RenderCanonicalFields): string {
  const { host, classroomId, slideId, exp } = fields;
  return [CANONICAL_VERSION, 'render', host, classroomId, slideId, exp].join('|');
}

/** `cm1|theme|{host}|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}` */
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
