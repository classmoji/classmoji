import { bucketExpiry, nowSeconds } from './bucket.ts';
import {
  TRANSFORM_WIDTHS,
  assertClassroomId,
  assertKeyVersion,
  assertTier,
  assertTransform,
  blobCanonicalString,
  isExt,
  isGitSha,
  isTheme,
  themeCanonicalString,
  toBase64Url,
} from './canonical.ts';
import { deriveKey, signCanonical } from './derive.ts';
import type { SigningContext, Transform, TransformFormat, TransformWidth } from './types.ts';

export interface BlobRef {
  sha: string;
  ext: string;
  transform?: Transform;
}

export interface ThemeRef {
  theme: string;
  treeSha: string;
}

export interface SrcSetRef {
  sha: string;
  ext: string;
  /** Intrinsic width of the source image. Widths above it are never emitted. */
  sourceWidth?: number;
  fmt?: TransformFormat;
}

export interface SrcSet {
  src: string;
  srcset: string;
}

function normalizeOrigin(origin: string): string {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new TypeError('content-signing: origin must be a non-empty string');
  }
  return origin.replace(/\/+$/, '');
}

function assertContext(ctx: SigningContext): void {
  assertTier(ctx.tier);
  assertClassroomId(ctx.classroomId);
  assertKeyVersion(ctx.keyVersion);
}

/**
 * `{origin}/c/{classroomId}/blob/{sha}.{ext}?p&v&exp&sig[&w][&fmt]`
 *
 * Transform params are inside the signature, so a client cannot widen or
 * re-encode an image it was not handed.
 */
export async function signBlobUrl(
  origin: string,
  ctx: SigningContext,
  ref: BlobRef
): Promise<string> {
  const base = normalizeOrigin(origin);
  assertContext(ctx);
  if (!isGitSha(ref.sha)) {
    throw new TypeError(`content-signing: sha must be a 40-hex git blob sha (got ${ref.sha})`);
  }
  if (!isExt(ref.ext)) {
    throw new TypeError(
      `content-signing: ext must be <=8 lowercase alphanumerics (got ${ref.ext})`
    );
  }
  assertTransform(ref.transform);

  const now = ctx.now ?? nowSeconds();
  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = blobCanonicalString({
    classroomId: ctx.classroomId,
    sha: ref.sha,
    ext: ref.ext,
    tier: ctx.tier,
    keyVersion: ctx.keyVersion,
    exp,
    transform: ref.transform,
  });

  const key = await deriveKey(ctx.master, ctx.classroomId, ctx.keyVersion);
  const sig = toBase64Url(await signCanonical(key, canonical));

  const query = [`p=${ctx.tier}`, `v=${ctx.keyVersion}`, `exp=${exp}`, `sig=${sig}`];
  if (ref.transform?.w !== undefined) query.push(`w=${ref.transform.w}`);
  if (ref.transform?.fmt !== undefined) query.push(`fmt=${ref.transform.fmt}`);

  return `${base}/c/${ctx.classroomId}/blob/${ref.sha}.${ref.ext}?${query.join('&')}`;
}

/**
 * `{origin}/c/{classroomId}/theme/{theme}/{treeSha}/{p}.{v}.{exp}.{sig}/`
 *
 * The signature lives in the path so relative `url()` references inside the
 * theme's CSS resolve against it and inherit authorization. Always ends in a
 * slash; the caller appends the relative path.
 */
export async function signThemeBase(
  origin: string,
  ctx: SigningContext,
  ref: ThemeRef
): Promise<string> {
  const base = normalizeOrigin(origin);
  assertContext(ctx);
  if (!isTheme(ref.theme)) {
    throw new TypeError(`content-signing: theme must match [a-z0-9._-]+ (got ${ref.theme})`);
  }
  if (!isGitSha(ref.treeSha)) {
    throw new TypeError(
      `content-signing: treeSha must be a 40-hex git tree sha (got ${ref.treeSha})`
    );
  }

  const now = ctx.now ?? nowSeconds();
  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = themeCanonicalString({
    classroomId: ctx.classroomId,
    theme: ref.theme,
    treeSha: ref.treeSha,
    tier: ctx.tier,
    keyVersion: ctx.keyVersion,
    exp,
  });

  const key = await deriveKey(ctx.master, ctx.classroomId, ctx.keyVersion);
  const sig = toBase64Url(await signCanonical(key, canonical));
  const policy = `${ctx.tier}.${ctx.keyVersion}.${exp}.${sig}`;

  return `${base}/c/${ctx.classroomId}/theme/${ref.theme}/${ref.treeSha}/${policy}/`;
}

/**
 * A responsive set for one image. Widths larger than `sourceWidth` are dropped
 * so the pipeline never upscales; when `sourceWidth` is unknown all three are
 * emitted. `src` is the largest signed width, as the non-srcset fallback.
 */
export async function signSrcSet(
  origin: string,
  ctx: SigningContext,
  ref: SrcSetRef
): Promise<SrcSet> {
  if (ref.sourceWidth !== undefined) {
    if (!Number.isInteger(ref.sourceWidth) || ref.sourceWidth <= 0) {
      throw new TypeError('content-signing: sourceWidth must be a positive integer');
    }
  }

  const widths: TransformWidth[] = TRANSFORM_WIDTHS.filter(
    width => ref.sourceWidth === undefined || width <= ref.sourceWidth
  );

  // Source narrower than the smallest rendition: serve it untransformed.
  if (widths.length === 0) {
    const src = await signBlobUrl(origin, ctx, {
      sha: ref.sha,
      ext: ref.ext,
      transform: ref.fmt ? { fmt: ref.fmt } : undefined,
    });
    return { src, srcset: `${src} ${ref.sourceWidth}w` };
  }

  const urls = await Promise.all(
    widths.map(width =>
      signBlobUrl(origin, ctx, {
        sha: ref.sha,
        ext: ref.ext,
        transform: ref.fmt ? { w: width, fmt: ref.fmt } : { w: width },
      })
    )
  );

  return {
    src: urls[urls.length - 1] as string,
    srcset: urls.map((url, index) => `${url} ${widths[index]}w`).join(', '),
  };
}
