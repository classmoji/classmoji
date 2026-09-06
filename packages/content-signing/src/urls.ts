import { bucketExpiry, nowSeconds } from './bucket.ts';
import {
  TRANSFORM_WIDTHS,
  assertClassroomId,
  assertKeyVersion,
  assertNow,
  assertTier,
  assertTransform,
  blobCanonicalString,
  hostOf,
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

const SMALLEST_WIDTH = TRANSFORM_WIDTHS[0];
const LARGEST_WIDTH = TRANSFORM_WIDTHS[TRANSFORM_WIDTHS.length - 1];

function normalizeOrigin(origin: string): string {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new TypeError('content-signing: origin must be a non-empty string');
  }
  return origin.replace(/\/+$/, '');
}

function assertContext(ctx: SigningContext): number {
  assertTier(ctx.tier);
  assertClassroomId(ctx.classroomId);
  assertKeyVersion(ctx.keyVersion);
  const now = ctx.now ?? nowSeconds();
  assertNow(now);
  return now;
}

/**
 * `{origin}/c/{classroomId}/blob/{sha}.{ext}?p&v&exp&sig[&w][&fmt]`
 *
 * Transform params are inside the signature, so a client cannot widen or
 * re-encode an image it was not handed. So is the origin's host.
 */
export async function signBlobUrl(
  origin: string,
  ctx: SigningContext,
  ref: BlobRef
): Promise<string> {
  const base = normalizeOrigin(origin);
  const host = hostOf(base);
  const now = assertContext(ctx);
  if (!isGitSha(ref.sha)) {
    throw new TypeError(`content-signing: sha must be a 40-hex git blob sha (got ${ref.sha})`);
  }
  if (!isExt(ref.ext)) {
    throw new TypeError(
      `content-signing: ext must be <=8 lowercase alphanumerics (got ${ref.ext})`
    );
  }
  assertTransform(ref.transform);

  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = blobCanonicalString({
    host,
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
  const host = hostOf(base);
  const now = assertContext(ctx);
  if (!isTheme(ref.theme)) {
    throw new TypeError(
      `content-signing: theme must match [a-z0-9][a-z0-9._-]* (got ${ref.theme})`
    );
  }
  if (!isGitSha(ref.treeSha)) {
    throw new TypeError(
      `content-signing: treeSha must be a 40-hex git tree sha (got ${ref.treeSha})`
    );
  }

  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = themeCanonicalString({
    host,
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
 * A responsive set for one image.
 *
 * Rungs larger than `sourceWidth` are dropped so the pipeline never upscales;
 * with no `sourceWidth` all three are emitted. When the source sits between
 * rungs (say 1599px) the untransformed original is added as the top candidate,
 * so it is not capped at the rung below. Above the top rung the cap is
 * deliberate and no original is added. `src` is the largest rendition.
 */
export async function signSrcSet(
  origin: string,
  ctx: SigningContext,
  ref: SrcSetRef
): Promise<SrcSet> {
  const { sourceWidth } = ref;
  if (sourceWidth !== undefined && (!Number.isSafeInteger(sourceWidth) || sourceWidth <= 0)) {
    throw new TypeError('content-signing: sourceWidth must be a positive integer');
  }

  const ladder: TransformWidth[] = TRANSFORM_WIDTHS.filter(
    width => sourceWidth === undefined || width <= sourceWidth
  );

  const betweenRungs =
    sourceWidth !== undefined &&
    sourceWidth > SMALLEST_WIDTH &&
    sourceWidth < LARGEST_WIDTH &&
    !(TRANSFORM_WIDTHS as readonly number[]).includes(sourceWidth);
  const needsOriginal = sourceWidth !== undefined && (ladder.length === 0 || betweenRungs);

  const specs: { transform: Transform | undefined; width: number }[] = ladder.map(width => ({
    transform: ref.fmt ? { w: width, fmt: ref.fmt } : { w: width },
    width,
  }));
  if (needsOriginal) {
    specs.push({ transform: ref.fmt ? { fmt: ref.fmt } : undefined, width: sourceWidth as number });
  }

  const urls = await Promise.all(
    specs.map(spec =>
      signBlobUrl(origin, ctx, { sha: ref.sha, ext: ref.ext, transform: spec.transform })
    )
  );

  // The fallback stays a bounded rendition wherever one exists.
  const srcIndex = ladder.length > 0 ? ladder.length - 1 : 0;
  return {
    src: urls[srcIndex],
    srcset: urls.map((url, index) => `${url} ${specs[index].width}w`).join(', '),
  };
}
