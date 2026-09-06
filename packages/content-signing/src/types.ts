/**
 * How long a signed URL lives, named for its window.
 *
 * NOT access control — the signature is. A tier only decides the lifetime and
 * the cacheability of a URL that has already been minted for a viewer who was
 * allowed to have it:
 *
 *   - `edit`  — an exact 4h TTL, 5 minutes of grace, `no-store`. The editor's
 *               403-and-revalidate flow, and the only tier a writer is in.
 *   - `week`  — a 7-day bucket, 6h of grace, `immutable`.
 *   - `month` — a 30-day bucket, 6h of grace, `immutable`.
 *
 * Bucketed tiers are staggered per classroom, so every URL minted for one file
 * inside one bucket is byte-identical and therefore cacheable.
 */
export type Tier = 'edit' | 'week' | 'month';

/** Widths the image pipeline is allowed to render. */
export type TransformWidth = 800 | 1600 | 2560;

/** Output formats the image pipeline is allowed to render. */
export type TransformFormat = 'webp' | 'avif' | 'auto';

/** Optional image transform, always covered by the signature. */
export interface Transform {
  w?: TransformWidth;
  fmt?: TransformFormat;
}

/**
 * One master secret, or an ordered list of them for verification: the current
 * key first, then the previous one while a rotation is in flight. A bare string
 * is the single-key case and the only shape signing accepts.
 */
export type MasterSecrets = string | readonly string[];

/**
 * Which entry in that ordered list verified a signature. `previous` means the
 * URL was minted before the current rotation — worth a log line, because the
 * moment those stop arriving is the moment the previous key can be dropped.
 *
 * Unrelated to `keyVersion`, which is the classroom's own counter carried in
 * the URL. A key version retires one classroom's URLs; a key slot is which
 * master the whole deployment is holding.
 */
export type KeySlot = 'current' | 'previous';

/**
 * Everything needed to mint a URL for one classroom.
 *
 * `now` is unix seconds and defaults to the current wall clock. Pass it
 * explicitly wherever the output has to be deterministic.
 *
 * Signing takes exactly one master — the current one. Only verification ever
 * looks at more than one key.
 */
export interface SigningContext {
  master: string;
  classroomId: string;
  keyVersion: number;
  tier: Tier;
  now?: number;
}

/** Why a URL was not accepted. */
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
      keySlot: KeySlot;
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
      keySlot: KeySlot;
    }
  | { ok: false; reason: VerifyFailure };

/** Raw fields lifted out of a blob URL, before any cryptographic check. */
export interface ParsedBlobUrl {
  kind: 'blob';
  host: string;
  classroomId: string;
  sha: string;
  ext: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  sig: string;
  transform?: Transform;
}

/** Raw fields lifted out of a theme URL, before any cryptographic check. */
export interface ParsedThemeUrl {
  kind: 'theme';
  host: string;
  classroomId: string;
  theme: string;
  treeSha: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  sig: string;
  relPath: string;
}

export type ParsedContentUrl = ParsedBlobUrl | ParsedThemeUrl;
