/** Access tier a signed URL was minted for. */
export type Tier = 'public' | 'enrolled' | 'draft';

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
 * Everything needed to mint a URL for one classroom.
 *
 * `now` is unix seconds and defaults to the current wall clock. Pass it
 * explicitly wherever the output has to be deterministic.
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
