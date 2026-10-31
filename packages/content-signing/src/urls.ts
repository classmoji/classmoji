import { bucketExpiry, nowSeconds } from './bucket.ts';
import {
  MAX_FILES_GRANT_LENGTH,
  TRANSFORM_WIDTHS,
  assertClassroomId,
  assertKeyVersion,
  assertMediaId,
  assertMediaVariant,
  assertNow,
  assertTier,
  assertTransform,
  blobCanonicalString,
  filesCanonicalString,
  hostOf,
  isExt,
  isGitSha,
  isTheme,
  mediaCanonicalString,
  themeCanonicalString,
  toBase64Url,
  utf8,
} from './canonical.ts';
import { deriveKey, signCanonical } from './derive.ts';
import { encodeDownloadFilename, normalizeDownloadFilename } from './downloads.ts';
import type {
  FilesFolder,
  SigningContext,
  Tier,
  Transform,
  TransformFormat,
  TransformWidth,
} from './types.ts';
import { filesFoldersOk, filesGrantText } from './verify.ts';

export interface BlobRef {
  sha: string;
  ext: string;
  transform?: Transform;
  /**
   * RAW display filename for a save-to-disk URL (`Übung 1.pdf`, not base64).
   * Signing normalizes and encodes it; leave it off and the URL is byte-for-byte
   * the one this package has always minted. Requires the `download` tier — any
   * other is a TypeError.
   */
  dl?: string;
}

export interface ThemeRef {
  theme: string;
  treeSha: string;
}

export interface FilesRef {
  /** The folders the URL opens, in any order. Each needs its current tree sha. */
  folders: readonly FilesFolder[];
}

export interface MediaRef {
  /** The `MediaObject` row's uuid. */
  mediaId: string;
  /** `orig.{ext}`, `web-{hex12}.mp4` or `poster-{hex12}.jpg`. The app picks it from the row. */
  variant: string;
  /** RAW display filename for a save-to-disk URL. See `BlobRef.dl`. */
  dl?: string;
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
 * The ENCODED `dl` param for a save-to-disk URL, or undefined when there is none.
 *
 * Refused at mint rather than sanitized: the caller knows which file this is
 * and can say so, where the verifier could only serve a name nobody chose.
 *
 * A save-to-disk link is handed to ONE viewer for ONE save, which is what the
 * `download` tier's ten minutes and `no-store` are for. A `dl` on `week` or
 * `month` would put a per-viewer filename on a URL that is immutable for days,
 * so it is refused here rather than left to the caller to remember. Only
 * minting is restricted: the verifier keeps accepting whatever was validly
 * signed, including URLs minted before this rule.
 *
 * One rule for both shapes, so a blob download and a media download cannot
 * drift on what a filename may be.
 */
function downloadParam(tier: Tier, dl: string | undefined): string | undefined {
  if (dl === undefined) return undefined;
  if (tier !== 'download') {
    throw new TypeError(`content-signing: a dl filename requires the download tier (got ${tier})`);
  }
  const filename = normalizeDownloadFilename(dl);
  if (filename === null) {
    throw new TypeError(`content-signing: unusable download filename (got ${String(dl)})`);
  }
  return encodeDownloadFilename(filename);
}

/**
 * `{origin}/c/{classroomId}/blob/{sha}.{ext}?p&v&exp&sig[&w][&fmt][&dl]`
 *
 * Transform params are inside the signature, so a client cannot widen or
 * re-encode an image it was not handed. So is the origin's host, and so is `dl`
 * — the name a download is saved under is not something a link can be edited to
 * change. `dl` is `download`-tier only; see the guard below.
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

  const dl = downloadParam(ctx.tier, ref.dl);

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
    dl,
  });

  const key = await deriveKey(ctx.master, ctx.classroomId, ctx.keyVersion);
  const sig = toBase64Url(await signCanonical(key, canonical));

  const query = [`p=${ctx.tier}`, `v=${ctx.keyVersion}`, `exp=${exp}`, `sig=${sig}`];
  if (ref.transform?.w !== undefined) query.push(`w=${ref.transform.w}`);
  if (ref.transform?.fmt !== undefined) query.push(`fmt=${ref.transform.fmt}`);
  // base64url needs no escaping, so the query is still assembled by hand — the
  // URL a caller gets back is the exact string the signature was taken over.
  if (dl !== undefined) query.push(`dl=${dl}`);

  return `${base}/c/${ctx.classroomId}/blob/${ref.sha}.${ref.ext}?${query.join('&')}`;
}

/**
 * `{origin}/c/{classroomId}/media/{mediaId}/{variant}?p&v&exp&sig[&dl]`
 *
 * `signBlobUrl` with the path swapped: the same tiers, the same bucketed
 * expiry, the same per-classroom derived key and the same `dl` rule. What
 * differs is what the URL addresses — a row in the media bucket rather than a
 * git blob — and that media is never transformed, so there is no `w`/`fmt`.
 *
 * Which variant to sign is the app's decision (the rendition once the P2 job
 * has produced one, the original until then); the Worker holds no state about
 * it and a new variant is simply a new URL.
 */
export async function signMediaUrl(
  origin: string,
  ctx: SigningContext,
  ref: MediaRef
): Promise<string> {
  const base = normalizeOrigin(origin);
  const host = hostOf(base);
  const now = assertContext(ctx);
  assertMediaId(ref.mediaId);
  assertMediaVariant(ref.variant);

  const dl = downloadParam(ctx.tier, ref.dl);

  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = mediaCanonicalString({
    host,
    classroomId: ctx.classroomId,
    mediaId: ref.mediaId,
    variant: ref.variant,
    tier: ctx.tier,
    keyVersion: ctx.keyVersion,
    exp,
    dl,
  });

  const key = await deriveKey(ctx.master, ctx.classroomId, ctx.keyVersion);
  const sig = toBase64Url(await signCanonical(key, canonical));

  const query = [`p=${ctx.tier}`, `v=${ctx.keyVersion}`, `exp=${exp}`, `sig=${sig}`];
  if (dl !== undefined) query.push(`dl=${dl}`);

  return `${base}/c/${ctx.classroomId}/media/${ref.mediaId}/${ref.variant}?${query.join('&')}`;
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
 * The grant segment for a set of folders: base64url (no padding) of
 * `{path}\t{treeSha}` lines, sorted by path in code-unit order, joined by `\n`.
 *
 * Throws a TypeError for a set no verifier would accept — empty or more than
 * twelve, the repo root, a path that is not already in normalized form, a
 * duplicate, one folder inside another, or a sha that is not 40 hex — so a
 * bad grant fails where it is minted rather than as a 403 in a browser.
 */
export function encodeFilesGrant(folders: readonly FilesFolder[]): string {
  const sorted = folders
    .map(folder => ({ path: folder.path, treeSha: folder.treeSha }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!filesFoldersOk(sorted)) {
    throw new TypeError(
      `content-signing: unusable files grant (${folders.map(f => f.path).join(', ') || 'no folders'})`
    );
  }
  const grant = toBase64Url(utf8(filesGrantText(sorted)));
  if (grant.length > MAX_FILES_GRANT_LENGTH) {
    throw new TypeError('content-signing: files grant is too long');
  }
  return grant;
}

/**
 * `{origin}/c/{classroomId}/files/{grant}/{p}.{v}.{exp}.{sig}/`
 *
 * The theme shape over several folders at once: the signature lives in the
 * path, so a page served from one of the folders resolves its relative
 * references against it and they inherit the grant. Always ends in a slash;
 * the caller appends the repo path (and any query, which is not signed).
 */
export async function signFilesBase(
  origin: string,
  ctx: SigningContext,
  ref: FilesRef
): Promise<string> {
  const base = normalizeOrigin(origin);
  const host = hostOf(base);
  const now = assertContext(ctx);
  const grant = encodeFilesGrant(ref.folders);

  const exp = bucketExpiry(ctx.tier, ctx.classroomId, now);
  const canonical = filesCanonicalString({
    host,
    classroomId: ctx.classroomId,
    grant,
    tier: ctx.tier,
    keyVersion: ctx.keyVersion,
    exp,
  });

  const key = await deriveKey(ctx.master, ctx.classroomId, ctx.keyVersion);
  const sig = toBase64Url(await signCanonical(key, canonical));
  const policy = `${ctx.tier}.${ctx.keyVersion}.${exp}.${sig}`;

  return `${base}/c/${ctx.classroomId}/files/${grant}/${policy}/`;
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
