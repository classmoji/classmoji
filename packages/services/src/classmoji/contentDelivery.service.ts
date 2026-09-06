import getPrisma from '@classmoji/database';
import {
  parseContentUrl,
  signBlobUrl,
  signSrcSet,
  signThemeBase,
  type SigningContext,
  type Tier,
  type TransformFormat,
  type TransformWidth,
} from '@classmoji/content-signing';
import { ContentService } from '../content/ContentService.ts';
import {
  type ContentAssetRecord,
  ensureContentAssets,
  lookupContentAsset,
  lookupContentAssetBySha,
  lookupContentAssets,
  lookupContentTree,
} from './contentAssets.service.ts';
import { extractOwnRepoPath } from './contentRefs.ts';

/** Where shared slide themes live in a content repo. Mirrors contentAssets. */
const THEMES_FOLDER = '.slidesthemes';

/**
 * Content delivery controls that are not about the asset map itself.
 *
 * Right now that is one thing: the cache bust.
 */

/**
 * Bump a classroom's content key version — the edge-cache bust.
 *
 * Every signed content URL carries the version, so incrementing it changes ALL
 * of a classroom's URLs at once and the CDN misses on every asset until it
 * refills from origin. That is the entire mechanism, and it is worth being
 * precise about what it is NOT:
 *
 *   - It is not a revocation. A URL minted under version 3 still verifies after
 *     the bump to 4; anyone holding one keeps their access. This changes which
 *     URL the app hands out, nothing more.
 *   - It is not a repair for wrong content. If the map says a path is at the
 *     wrong sha, a fresh URL points at the same wrong sha — that is a sync
 *     problem, and `syncContentAssets` is the fix.
 *
 * What it IS for: a stale or poisoned EDGE cache — the CDN entries keyed by URL.
 * It does NOT reach R2: the Worker keys R2 by content (`blobs/{sha}`), shared
 * across classrooms and independent of the version, and it checks R2 before
 * the origin. A bad object in R2 — a wrong body cached under the right sha —
 * survives a bump; the lever for that layer is deleting the object
 * (`wrangler r2 object delete`), after which the next miss refills it from
 * origin. Two layers, two levers.
 *
 * The write is a relative increment (`{ increment: 1 }`) rather than a
 * read-then-write, so two owners clicking at the same moment produce two bumps
 * instead of one lost update. Both land, which is harmless — the version is
 * only ever compared for equality with itself.
 */
export async function bumpContentKeyVersion(
  classroomId: string
): Promise<{ content_key_version: number }> {
  const updated = await getPrisma().classroom.update({
    where: { id: classroomId },
    data: { content_key_version: { increment: 1 } },
    select: { content_key_version: true },
  });

  return { content_key_version: updated.content_key_version };
}

// ─────────────────────────────────────────────────────────────────────────────
// Render-time URL resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The URL is a VIEW, not data.
 *
 * `content.json` and deck HTML store plain references — `pages/lab-1/assets/
 * hero.png`, or a legacy absolute URL into the repo. A signed delivery URL is
 * derived from three things at the moment of rendering: the reference, the
 * file's current SHA (the `ContentAsset` map), and policy (tier +
 * `content_key_version`). None of that is stable enough to store, which is the
 * whole point:
 *
 *   - a signature expires, so a stored one rots into a broken image;
 *   - the SHA changes when the file changes, so a stored URL stops following
 *     its file and a re-upload never shows;
 *   - the tier is per-VIEWER, so one stored URL cannot be right for a student
 *     and for the instructor editing the same page.
 *
 * Everything here is therefore pure derivation, and the save paths run
 * `canonicalizeAssetRef` to make sure the derivation never leaks back into
 * storage.
 *
 * ## Referenced content, and root content
 *
 * Everything above is about REFERENCED content — the images a document points
 * at. The plan's other half is ROOT content: `content.json`, `deck.json`, the
 * generated `index.html`. Nothing points at those, so for a long time nothing
 * could address them by sha and they were read straight from GitHub — the Pages
 * CDN first, the App token's contents API behind it.
 *
 * That is no longer true, and `fetchContentText` below is where it stopped
 * being true. A save records the sha its commit returned (`recordContentAsset`),
 * so the map answers "what is current?" for root files exactly as it does for
 * referenced ones, and a read signs that sha like any other blob. The pointer
 * the reference graph was missing is the map row.
 *
 * What that buys is not bandwidth — these files are small. It is that GitHub is
 * touched once per SAVE instead of once per VIEW, and that a `/present` opened
 * a second after a save shows the deck that was just saved.
 */

/** Signature lifetime a render mints URLs for. See @classmoji/content-signing. */
export type ResolveTier = Tier;

/** The classroom fields a resolve needs. Narrow on purpose — no secrets. */
export interface ResolveClassroom {
  id: string;
  content_key_version: number;
  content_repo: string;
  git_organization: { login: string };
  /**
   * This classroom's own switch. REQUIRED, and deliberately not optional: a
   * caller that forgets it would otherwise get `undefined`, and the difference
   * between "off" and "the caller did not say" is exactly the difference
   * between a safe deploy and every classroom in production being switched over
   * at once. Typed as required so the compiler names every context builder.
   */
  content_delivery_enabled: boolean;
}

export interface ResolveContext {
  classroom: ResolveClassroom;
  tier: ResolveTier;
}

/** Widths/formats a caller may ask the image pipeline for. */
export interface ResolveTransform {
  w?: TransformWidth;
  fmt?: TransformFormat;
}

/**
 * How stale the asset map may be before a render re-syncs it.
 *
 * A day, not a minute: the push webhook is what keeps the map current, and
 * this is only the backstop for a delivery that never arrived. Making it short
 * would put a GitHub tree call on the render path of every quiet classroom for
 * no gain.
 */
const ENSURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Is the delivery layer switched on for this deployment?
 *
 * BOTH env vars, because either one alone is useless: no secret means nothing
 * can be signed, no origin means nothing knows where to point. When this is
 * false every function below returns its input unchanged and the app renders
 * through the legacy raw/Pages/proxy URLs exactly as it did before — which is
 * what keeps production safe until the Worker exists there.
 */
export function isContentDeliveryConfigured(): boolean {
  return Boolean(process.env.CONTENT_SIGNING_SECRET && process.env.CONTENT_DELIVERY_ORIGIN);
}

/**
 * Is the delivery layer switched on for THIS classroom?
 *
 * The env check above is about the deployment; this is about the row. Both have
 * to be true, and the two are separate on purpose: production Fly apps already
 * carry `CONTENT_SIGNING_SECRET` and `CONTENT_DELIVERY_ORIGIN`, so a gate made
 * of env alone would have flipped every classroom the moment this deployed. The
 * column defaults to false, which makes that deploy a no-op and turns rollout
 * into a decision per classroom.
 *
 * Strict `=== true` rather than truthiness: a caller that selected the row
 * without the column gets `undefined`, and "I did not ask" must read as off.
 */
export function isContentDeliveryEnabled(
  classroom: { content_delivery_enabled?: boolean | null } | null | undefined
): boolean {
  return classroom?.content_delivery_enabled === true;
}

/**
 * The env + classroom pair, or null when either half says no.
 *
 * Every resolver's first line. Returning null is what produces the legacy
 * result — the reference back unchanged, or `null` for the entry points whose
 * "no" is an absence — and it is byte-identical whether the deployment cannot
 * sign or this classroom has not been opted in.
 */
function deliveryEnvFor(ctx: ResolveContext): { origin: string; master: string } | null {
  if (!isContentDeliveryEnabled(ctx.classroom)) return null;
  return deliveryEnv();
}

function deliveryEnv(): { origin: string; master: string } | null {
  const origin = process.env.CONTENT_DELIVERY_ORIGIN;
  const master = process.env.CONTENT_SIGNING_SECRET;
  if (!origin || !master) return null;
  return { origin, master };
}

/**
 * Which LIFETIME this render mints URLs for.
 *
 * Not a permission, however the names used to read: what a viewer is allowed
 * to fetch is decided by the signature, and by the authorization the caller
 * did before it got here. A tier only picks how long the URL lives and whether
 * it may be cached.
 *
 *   - `edit` for anyone who can edit and for an explicit staff preview. Both
 *     are looking at bytes that may be about to change, and both depend on the
 *     403-and-revalidate flow, which is what the exact 4h TTL and `no-store`
 *     are for.
 *   - `month` for content that is PUBLIC. Its readers are anonymous by
 *     definition, so there is nothing a shorter lifetime would buy.
 *   - `week` for everything else.
 *
 * Order matters: an instructor previewing their own public page is editing,
 * not browsing, so the edit check comes first.
 *
 * `isPublic` is the CONTENT's own visibility — `Page.is_public`, a deck's
 * `is_public` — and never "is this the class-site surface". Keying off the
 * SURFACE is what this replaces, and what it got wrong: the same public page
 * was minted `p=enrolled` inside the pages app and `p=public` on the class
 * site, so one public file had two lifetimes and two cache entries depending
 * on which door a reader came through. Visibility is a property of the file;
 * the surface is not.
 */
export function tierFor({
  canEdit,
  preview,
  isPublic,
}: {
  canEdit: boolean;
  preview?: boolean;
  isPublic?: boolean;
}): ResolveTier {
  if (canEdit || preview) return 'edit';
  if (isPublic) return 'month';
  return 'week';
}

/**
 * The signing context for one pass, optionally pinned to one clock.
 *
 * `now` matters more than it looks. Expiries are BUCKETED, so two signatures
 * minted a tick apart usually land in the same bucket and come out identical —
 * usually. Straddle a bucket boundary and they do not, and a caller that pairs
 * a `src` with its `srcset` by string equality (which is the whole contract
 * between `resolveMany` and `resolveSrcSets`) silently drops every set.
 *
 * So a pass that mints more than one URL pins its own `now` and hands the same
 * one to every signature in the batch. `nowSeconds()` is read once, at the top.
 */
function signingContext(ctx: ResolveContext, master: string, now?: number): SigningContext {
  return {
    master,
    classroomId: ctx.classroom.id,
    keyVersion: ctx.classroom.content_key_version,
    tier: ctx.tier,
    ...(now === undefined ? {} : { now }),
  };
}

/** Unix seconds — the one clock read a batched pass pins itself to. */
function passClock(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A stored reference → the repo path it names, or null when it is not ours.
 *
 * Case 1 (a repo-relative reference) is the shape everything new writes, and
 * it passes through untouched. Case 2 (an absolute URL into THIS classroom's
 * content repo, in any of the three shapes the app has ever emitted) is
 * reduced to its path by `extractOwnRepoPath`. Case 3 — external URLs, another
 * classroom's repo, `data:` — is null, and the caller leaves it alone.
 *
 * A protocol-bearing reference that is not one of ours is rejected before the
 * relative branch can claim it; without that check `https://example.com/a.png`
 * would be looked up as the repo path `https://example.com/a.png`.
 */
function toRepoPath(ctx: ResolveContext, ref: string): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return null;

  const own = extractOwnRepoPath(
    ref,
    ctx.classroom.git_organization.login,
    ctx.classroom.content_repo
  );
  if (own) return own;

  // Anything with a scheme, a protocol-relative prefix, or a root-relative
  // path that `extractOwnRepoPath` did not claim belongs to somebody else.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('/')) return null;
  if (ref.startsWith('#') || ref.startsWith('?')) return null;

  return normalizeRepoRelative(ref);
}

/**
 * Collapse a relative reference to the repo-root form the asset map is keyed by.
 *
 * `./` segments and duplicate slashes are cosmetic; a leading `../` is not
 * resolvable without knowing which page the reference came from, so those are
 * refused rather than guessed at. Uploads write the folder-qualified path
 * (`pages/lab-1/assets/x.png` — see `uploadPageAsset`, which uploads into
 * `${content_path}/assets`), so a bare `assets/x.png` is already the exception
 * rather than the rule.
 */
function normalizeRepoRelative(ref: string): string | null {
  const parts = ref.split('/').filter(part => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * Extensions a responsive set is worth emitting for.
 *
 * Deliberately narrow. `gif` is excluded because the pipeline's resize would
 * flatten an animation to a still; `svg` because it is already resolution
 * independent and rasterizing it is a downgrade; everything non-image because
 * a `w=` on a PDF is meaningless. A file that is not on this list gets the
 * plain signed URL and no `srcset`, which is the correct answer, not a
 * degradation.
 */
const RASTER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);

/**
 * The `sizes` hint a page or deck image ships with.
 *
 * One constant, shared by the pages viewer, the class site and the deck
 * rewrite, because the three must not drift into three different answers for
 * the same image. An image block is laid out at the full width of the article
 * column, and the widest column the editor offers is `max-w-7xl`; below a
 * desktop breakpoint it is the viewport. 1024px is the middle of the column
 * range and errs one rung low rather than high, which costs a slightly softer
 * image on the widest setting and saves a 2560px download on every other one.
 */
export const IMAGE_SIZES = '(max-width: 1024px) 100vw, 1024px';

/** Is this path one the image pipeline should produce a responsive set for? */
export function isRasterImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== null && RASTER_IMAGE_EXTENSIONS.has(ext);
}

/** Lowercased extension, or null when the path has none. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The deterministic 404 for a reference the map has never heard of.
 *
 * A URL rather than a thrown error or a silent passthrough: the page still
 * renders, the broken image is visibly broken in exactly one recognizable
 * shape, and the same missing reference always produces the same URL so an
 * edge cache does not fill with variants of one mistake.
 */
function missingUrl(origin: string, classroomId: string, ref: string): string {
  return `${origin.replace(/\/+$/, '')}/c/${classroomId}/missing/${encodeURIComponent(ref)}`;
}

/**
 * A `/missing/` placeholder of ours → the reference it was minted for.
 *
 * The placeholder is a URL we hand a render when the map has never heard of a
 * reference, and it is the one derived URL that is NOT a signature — so
 * `parseContentUrl` does not see it and, until this existed, neither did the
 * save path. A render that produced one, a browser that handed it back, and a
 * save that stored it turned a temporarily-unresolvable reference into a
 * permanently broken one: the placeholder does not name a file, so no later
 * sync can ever repair it.
 *
 * Matched by shape rather than by parsing, and scoped to THIS classroom: another
 * classroom's placeholder decodes to a path that means nothing here.
 *
 * Null when the string is not one of ours, which is every ordinary reference.
 */
const MISSING_URL =
  /^https?:\/\/[^/]+\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/missing\/([^/?#]+)$/i;

function parseMissingUrl(ctx: ResolveContext, ref: string): string | null {
  const match = MISSING_URL.exec(ref);
  if (!match || match[1].toLowerCase() !== ctx.classroom.id.toLowerCase()) return null;
  try {
    const decoded = decodeURIComponent(match[2]);
    return decoded.length > 0 ? decoded : null;
  } catch {
    // A placeholder we did not mint, or one mangled in transit. Not ours to
    // rewrite — leave the caller's string alone.
    return null;
  }
}

/** Sign one already-resolved asset, degrading to the legacy ref on refusal. */
async function signAsset(
  ctx: ResolveContext,
  env: { origin: string; master: string },
  ref: string,
  path: string,
  sha: string,
  transform?: ResolveTransform,
  now?: number
): Promise<string> {
  const ext = extensionOf(path);
  if (!ext) {
    console.warn(`[contentDelivery] No extension on ${path} (classroom ${ctx.classroom.id})`);
    return ref;
  }
  try {
    return await signBlobUrl(env.origin, signingContext(ctx, env.master, now), {
      sha,
      ext,
      ...(transform ? { transform } : {}),
    });
  } catch (error) {
    // A refusal here is a validation error (an ext the signer will not take, a
    // classroom id that is not a UUID) — never a reason to break the render.
    console.warn(
      `[contentDelivery] Could not sign ${path} for classroom ${ctx.classroom.id}:`,
      error instanceof Error ? error.message : error
    );
    return ref;
  }
}

/** The map lookup shared by every single-ref entry point. */
async function resolveOne(
  ctx: ResolveContext,
  env: { origin: string; master: string },
  ref: string,
  transform?: ResolveTransform,
  now?: number
): Promise<string> {
  const path = toRepoPath(ctx, ref);
  if (!path) return ref;

  const asset = await lookupContentAsset(ctx.classroom.id, path);
  // A tree row is not a file. `lookupContentAsset` is keyed by path alone, so a
  // reference naming a DIRECTORY comes back with the folder's tree sha — and
  // signing that as a blob would mint a confidently-wrong URL the Worker cannot
  // serve. There is no blob at that path, which is what `/missing/` means.
  if (!asset || asset.type !== 'blob') {
    console.warn(
      `[contentDelivery] No blob row for "${ref}" (path ${path}) in classroom ${ctx.classroom.id}`
    );
    return missingUrl(env.origin, ctx.classroom.id, ref);
  }

  return signAsset(ctx, env, ref, path, asset.sha, transform, now);
}

/**
 * One stored reference → the signed URL this viewer should load it from.
 *
 * Unconfigured, external, or unresolvable → the reference comes back exactly as
 * it went in, so a caller can always assign the result straight into `src`.
 */
export async function resolveAssetUrl(
  ctx: ResolveContext,
  ref: string,
  opts: { transform?: ResolveTransform } = {}
): Promise<string> {
  const env = deliveryEnvFor(ctx);
  if (!env) return ref;

  await ensureMap(ctx.classroom.id);
  return resolveOne(ctx, env, ref, opts.transform);
}

/**
 * Sign one already-resolved raster image as `{ src, srcset }`.
 *
 * `src` is the PLAIN signed URL — no `w=`, no `fmt=` — deliberately, and this
 * is the one place it matters. It is the untransformed original, so it is
 * byte-identical to what `resolveAssetUrl` and `resolveMany` hand back for the
 * same reference; a caller can therefore pair a resolved `src` with its set by
 * string equality, which is exactly what the render-time passes do. It is also
 * the safe fallback for a browser that ignores `srcset` entirely.
 *
 * The ladder carries `fmt=auto`, so each rung is served as WebP or AVIF to the
 * browsers that accept them and as the original format to the ones that do not.
 *
 * No `sourceWidth` is passed: the asset map stores a file's size in BYTES, not
 * its pixel width, so all three rungs are emitted and the Worker's `scale-down`
 * fit is what keeps a 900px source from being upscaled to 2560 — it caps at the
 * source and stops. The cost of not knowing the width is a slightly wasteful
 * candidate list, never a blurry image.
 */
async function signResponsive(
  ctx: ResolveContext,
  env: { origin: string; master: string },
  path: string,
  sha: string,
  now?: number
): Promise<{ src: string; srcset: string } | null> {
  const ext = extensionOf(path);
  if (!ext || !RASTER_IMAGE_EXTENSIONS.has(ext)) return null;

  try {
    const signing = signingContext(ctx, env.master, now);
    const [src, ladder] = await Promise.all([
      signBlobUrl(env.origin, signing, { sha, ext }),
      signSrcSet(env.origin, signing, { sha, ext, fmt: 'auto' }),
    ]);
    return { src, srcset: ladder.srcset };
  } catch (error) {
    console.warn(
      `[contentDelivery] Could not sign a srcset for ${path} in classroom ${ctx.classroom.id}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * A responsive `{ src, srcset }` for one image reference.
 *
 * Null — not a passthrough string — whenever a responsive set cannot or should
 * not be built: the layer is off for this classroom or deployment, the
 * reference is not ours, the map has never heard of it, it is not a raster
 * image, or it cannot be signed. The caller needs to tell "here is a srcset"
 * from "there is no srcset", and an unsigned legacy URL is a `src`, not a set.
 */
export async function resolveAssetSrcSet(
  ctx: ResolveContext,
  ref: string
): Promise<{ src: string; srcset: string } | null> {
  const env = deliveryEnvFor(ctx);
  if (!env) return null;

  const path = toRepoPath(ctx, ref);
  if (!path || !isRasterImagePath(path)) return null;

  await ensureMap(ctx.classroom.id);
  const asset = await lookupContentAsset(ctx.classroom.id, path);
  if (!asset || asset.type !== 'blob') {
    console.warn(
      `[contentDelivery] No blob row for "${ref}" (path ${path}) in classroom ${ctx.classroom.id}`
    );
    return null;
  }

  return signResponsive(ctx, env, path, asset.sha);
}

/**
 * Responsive sets for a whole page's images, in one pass.
 *
 * Keyed by the STORED reference — never by the signed URL. A consumer that had
 * to reproduce a signature to find its own entry would be reproducing a clock,
 * an expiry bucket and a tier, and would get it wrong the moment any of the
 * three moved. The stored ref is the one part of an image that does not move.
 *
 * Only references that actually GOT a set appear. A caller looks up
 * unconditionally and treats a miss as "render this one with a plain `src`",
 * which covers the gif, the svg, the external image and the file that is not an
 * image at all — all correct outcomes rather than failures.
 *
 * Prefer `resolveDelivery` when you also need the URLs: this discards them, and
 * resolving twice pays two map reads and risks two clocks.
 */
export async function resolveSrcSets(
  ctx: ResolveContext,
  refs: string[]
): Promise<Map<string, { src: string; srcset: string }>> {
  // Reduced BEFORE the map is touched: a gif, an svg, a PDF and an external
  // image all drop out on the shape of the reference alone, so a document full
  // of them costs no query at all.
  const raster = refs.filter(ref => {
    if (typeof ref !== 'string' || ref.length === 0) return false;
    const path = toRepoPath(ctx, ref);
    return path !== null && isRasterImagePath(path);
  });
  if (raster.length === 0) return new Map();

  const { srcSets } = await resolveDelivery(ctx, raster, { srcSets: true });
  return srcSets;
}

/**
 * The signed base URL of a shared slide theme's folder, ending in `/`.
 *
 * A theme is served as a FOLDER because its CSS uses relative `url()` for
 * fonts and images; the signature lives in the path so those relative
 * references inherit it. Addressed by the folder's TREE sha, which is why the
 * map escalates any `.slidesthemes/` change to a full sync.
 *
 * Null whenever the base cannot be built — the caller renders without theme
 * links rather than failing the read.
 */
export async function resolveThemeBase(
  ctx: ResolveContext,
  themeName: string
): Promise<string | null> {
  const env = deliveryEnvFor(ctx);
  if (!env || !themeName) return null;

  await ensureMap(ctx.classroom.id);
  const tree = await lookupContentTree(ctx.classroom.id, `${THEMES_FOLDER}/${themeName}`);
  if (!tree) {
    console.warn(
      `[contentDelivery] No tree row for theme "${themeName}" in classroom ${ctx.classroom.id}`
    );
    return null;
  }

  try {
    return await signThemeBase(env.origin, signingContext(ctx, env.master), {
      theme: themeName,
      treeSha: tree.sha,
    });
  } catch (error) {
    console.warn(
      `[contentDelivery] Could not sign theme "${themeName}" for classroom ${ctx.classroom.id}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Resolve a whole page's references — URLs and responsive sets — in one pass.
 *
 * This is the entry point a render should use. Three things happen exactly
 * once for the batch rather than once per image: the map freshness check (a DB
 * read, and possibly a GitHub tree call), the map lookup, and — the one that
 * bites — the CLOCK.
 *
 * Expiries are bucketed, so two signatures minted a tick apart are normally
 * identical. Normally. Straddle a bucket boundary and they are not, and a
 * caller pairing a `src` with its `srcset` by string equality silently drops
 * every set it just paid to compute. One `now`, read here, goes into every
 * signature below.
 *
 * Every input ref appears in `urls`, including the ones that resolve to
 * themselves, so a caller can look up unconditionally. `srcSets` holds only the
 * refs that earned one, keyed by the stored reference.
 */
export async function resolveDelivery(
  ctx: ResolveContext,
  refs: string[],
  opts: { srcSets?: boolean } = {}
): Promise<{ urls: Map<string, string>; srcSets: Map<string, { src: string; srcset: string }> }> {
  const unique = [...new Set(refs.filter(ref => typeof ref === 'string' && ref.length > 0))];
  const urls = new Map<string, string>();
  const srcSets = new Map<string, { src: string; srcset: string }>();

  const env = deliveryEnvFor(ctx);
  if (!env) {
    for (const ref of unique) urls.set(ref, ref);
    return { urls, srcSets };
  }

  // Reduce first, look up once. A reference that is not ours resolves to
  // itself without ever reaching the map, and the ones that remain share a
  // single `findMany` — the difference between a forty-image deck costing one
  // query per view and costing forty.
  const wanted = new Map<string, string>();
  for (const ref of unique) {
    const path = toRepoPath(ctx, ref);
    if (path) wanted.set(ref, path);
    else urls.set(ref, ref);
  }

  if (wanted.size === 0) return { urls, srcSets };

  await ensureMap(ctx.classroom.id);
  const assets = await lookupContentAssets(ctx.classroom.id, [...new Set(wanted.values())]);
  const now = passClock();

  await Promise.all(
    [...wanted].map(async ([ref, path]) => {
      const asset = assets.get(path);
      // Identical branching to `resolveOne`: a path the map has never heard of
      // and a TREE row both mean "there is no blob here", and both get the
      // deterministic /missing/ URL rather than a confidently-wrong signature.
      if (!asset || asset.type !== 'blob') {
        console.warn(
          `[contentDelivery] No blob row for "${ref}" (path ${path}) in classroom ${ctx.classroom.id}`
        );
        urls.set(ref, missingUrl(env.origin, ctx.classroom.id, ref));
        return;
      }

      if (opts.srcSets && isRasterImagePath(path)) {
        const set = await signResponsive(ctx, env, path, asset.sha, now);
        if (set) {
          // The set's `src` IS the plain signed URL under the same clock — so
          // this is not a second signature for the same file, it is the one.
          urls.set(ref, set.src);
          srcSets.set(ref, set);
          return;
        }
      }

      urls.set(ref, await signAsset(ctx, env, ref, path, asset.sha, undefined, now));
    })
  );

  return { urls, srcSets };
}

/**
 * Resolve a whole page's references in one pass.
 *
 * The URL-only form of `resolveDelivery`, kept because most callers want
 * exactly this and a `.urls` at every call site would be noise.
 */
export async function resolveMany(
  ctx: ResolveContext,
  refs: string[]
): Promise<Map<string, string>> {
  const { urls } = await resolveDelivery(ctx, refs);
  return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a repo's TEXT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a repo file's bytes actually came from. Logged, and returned so a
 * caller (and a staging log) can see the mix rather than guess at it.
 */
export type ContentTextSource = 'worker' | 'api' | 'cdn';

export interface ContentText {
  text: string;
  /**
   * The git blob sha the bytes came from, or null.
   *
   * Null is only ever the CDN's answer: GitHub Pages serves a path and reports
   * no object id, so there is nothing honest to put here. The Worker path takes
   * the sha it signed and the API path takes the one the contents API returned,
   * both of which name the exact object.
   */
  sha: string | null;
  source: ContentTextSource;
}

/**
 * What a text read needs to know. A `ResolveContext` satisfies it structurally,
 * so a caller that already built one for images can pass it straight through;
 * the tier on it is ignored (see below).
 */
export interface TextReadContext {
  classroom: ResolveClassroom;
}

/**
 * Which fallbacks a text read may use when the map cannot answer.
 *
 *   - `api-then-cdn` — the default, and the only ordering that is right for a
 *     single document a person is waiting on: the authenticated read always
 *     sees the current commit, and the case that reaches it (a map briefly
 *     behind a save) is exactly when the CDN is stalest.
 *   - `cdn-only` — for a FAN-OUT. A staff landing page renders ~20 deck
 *     thumbnails at once, and twenty authenticated reads is the amplification
 *     the CDN pinning existed to prevent. A thumbnail is a picture of a deck;
 *     three minutes stale is invisible there and a rate limit is not.
 *   - `none` — the map answers or it does not. For a caller that must tell "no
 *     such file" from "GitHub is down", because swallowing failures makes both
 *     of them `null`. The class site is the one that must: the first is an
 *     empty page, the second a 503, and a blank page cached for a minute in
 *     front of anonymous readers is the worse outcome.
 */
export type TextFallback = 'api-then-cdn' | 'cdn-only' | 'none';

/**
 * One render's worth of probes, and whether the Worker has already failed.
 *
 * Not a rate limiter — a circuit breaker with a lifetime of one render. A read
 * that probes several paths (a page tries `content.json`, then `index.html`)
 * would otherwise pay the full timeout on EVERY probe when the Worker is
 * unreachable, turning one stalled render into several. A transport failure is
 * about the origin, not the file, so the first one answers for all of them.
 *
 * A MISS is not a failure and never trips this: the map genuinely not having a
 * row for `content.json` says nothing about `index.html`.
 */
export interface TextReadBudget {
  workerUnavailable: boolean;
}

export function textReadBudget(): TextReadBudget {
  return { workerUnavailable: false };
}

/**
 * A hung origin must not hold a render open.
 *
 * The Worker answers an R2 hit in milliseconds and a cold miss in the time
 * GitHub takes, so anything past this is a network that has stopped rather than
 * a slow file — and the fallbacks below are still a correct answer. Short
 * enough that the fallback is not itself a timeout, long enough that a cold
 * blob on a bad day still wins.
 *
 * ## Why six seconds is a LATENCY CEILING and not a failure budget
 *
 * A cold pull through the Worker is genuinely slow — the origin leg has to mint
 * an installation token against the webapp and then pull the blob from GitHub,
 * and on a save-fresh sha both of those are cold. Measured on staging that is
 * seconds, not milliseconds, and it is why this number matters at all.
 *
 * Two things keep it from mattering often:
 *
 *   - `warmContentText` runs on every text SAVE, so the reader who opens a deck
 *     a second after it was written is usually hitting a sha the Worker has
 *     already pulled and put in R2. The cold pull is paid once, by a background
 *     fetch nobody is waiting on, instead of by the first person to look.
 *   - When a read DOES land cold and outruns this, nothing fails: the ladder in
 *     `readTextFromGitHub` answers from the contents API, and the Pages CDN
 *     behind that. So exceeding this budget costs a slower path to the same
 *     bytes, not an error — which is exactly what makes six seconds a ceiling
 *     on latency rather than a deadline the render can miss.
 *
 * Raising it would make a stalled Worker hold the render open for longer with
 * nothing gained; lowering it would start losing races the Worker was going to
 * win. Callers who want a tighter bound for a DECORATIVE read pass their own
 * `deadlineMs` (see `fetchContentText`) rather than moving this.
 */
const TEXT_FETCH_TIMEOUT_MS = 6000;

/**
 * The bound on the map refresh a read may trigger.
 *
 * `ensureMap` can reach GitHub for a default branch, a head commit and a whole
 * tree — three round trips, on the render path, for a classroom whose map has
 * gone stale. It already degrades to "serve what the map has" on failure, but
 * only after GitHub has finished being slow. This puts a ceiling on that.
 */
const ENSURE_MAP_TIMEOUT_MS = 4000;

/**
 * How long a classroom stays written off after a read finds it unreachable.
 *
 * Long enough to cover the page that provoked it and the two or three reloads
 * that follow — the fan-out this exists for is one screen's worth of thumbnails
 * and an instructor refreshing it. Short enough that a repo made readable again
 * (access restored, a private repo re-shared) starts working within a few
 * minutes without anyone restarting anything.
 */
const UNREACHABLE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Ceiling on how many classrooms may be remembered at once.
 *
 * The map is per-process and bounded twice — expired entries are dropped on
 * every insert, and this catches the pathological case where they arrive faster
 * than they expire. Reaching it clears the map rather than evicting one entry:
 * this is a latency optimization, and forgetting everything costs one slow read
 * per classroom, which is exactly the state it started in.
 */
const UNREACHABLE_MAX_CLASSROOMS = 500;

/**
 * Classrooms whose content origin answered nothing at all, and until when.
 *
 * ## The fan-out this is for
 *
 * The slides index renders every deck as an iframe, each of which runs the
 * thumbnail read in its own loader. When a classroom's content repo cannot be
 * read — access revoked, a repo gone private, a deleted repo still referenced —
 * every one of those reads burns its whole budget before failing, and with
 * ~19 thumbnails at a browser's ~6 concurrent connections the page dribbles in
 * over minutes and looks hung. The failure is a property of the CLASSROOM, not
 * of the 19 files, so the first read is entitled to answer for the rest.
 *
 * ## What may and may not consult it
 *
 * Only DECORATIVE reads (see `fetchContentText`). A thumbnail is a picture of a
 * deck and its absence costs a grey rectangle; a person actually opening that
 * deck must still make the attempt, because "the repo was unreadable four
 * minutes ago" is not an answer to "show me my slides" — and the window would
 * otherwise keep a recovered classroom broken for five minutes after it healed.
 *
 * ## What may write to it
 *
 * One leg, and one verdict: the WORKER leg concluding `unreachable` on a read
 * that produced no content. See `WorkerLegOutcome` for what earns that.
 *
 * The Worker alone, because it is the only leg that actually reports what it
 * found. The CDN leg answers 404 for every headline case this exists for — a
 * repo made private, a repo deleted, Pages never published — so a rule that
 * waited for both legs to fail armed for none of them: `{org}.github.io` said
 * "no such file" and the read looked, to that rule, like a missing `index.html`.
 *
 * And a 404 from the WORKER is still explicitly not a fault: that one really is
 * a missing file, and treating it as a classroom-wide outage would blank
 * thumbnails for decks whose `index.html` has simply not been generated yet.
 */
const unreachableClassrooms = new Map<string, { until: number }>();

/** Test/ops seam — the map is module state and would otherwise leak between cases. */
export function clearUnreachableClassrooms(): void {
  unreachableClassrooms.clear();
}

function isClassroomUnreachable(classroomId: string, now: number = Date.now()): boolean {
  const entry = unreachableClassrooms.get(classroomId);
  if (!entry) return false;
  if (entry.until <= now) {
    unreachableClassrooms.delete(classroomId);
    return false;
  }
  return true;
}

/**
 * Write a classroom off for a window, once.
 *
 * A read that lands inside an OPEN window neither extends it nor logs again:
 * the window is "we have already been told", and re-arming it on every failure
 * would let a steady trickle of reads keep a healed classroom written off
 * indefinitely. That also makes the log exactly one line per window, which is
 * the only rate that is readable when the trigger is a page of thumbnails.
 */
function rememberUnreachable(classroomId: string, path: string): void {
  const now = Date.now();
  if (isClassroomUnreachable(classroomId, now)) return;

  for (const [id, entry] of unreachableClassrooms) {
    if (entry.until <= now) unreachableClassrooms.delete(id);
  }
  if (unreachableClassrooms.size >= UNREACHABLE_MAX_CLASSROOMS) unreachableClassrooms.clear();
  unreachableClassrooms.set(classroomId, { until: now + UNREACHABLE_WINDOW_MS });

  // eslint-disable-next-line no-console
  console.debug(
    `[contentDelivery] classroom ${classroomId} content origin unreachable ` +
      `(last failure: ${path}); skipping decorative reads for ` +
      `${Math.round(UNREACHABLE_WINDOW_MS / 1000)}s`
  );
}

/**
 * What the Worker leg of one read concluded.
 *
 *   - `miss` — a 404. The sha is not there, which is PROOF the Worker and the
 *     repo behind it can be reached.
 *   - `refused` — an answer about THIS request rather than about the repo: a
 *     signature the Worker declined, a malformed URL. A deployment fault, and
 *     condemning the classroom for one would blank thumbnails for a repo that
 *     is perfectly healthy.
 *   - `unreachable` — the repo could not be read through the Worker: a 403, a
 *     5xx (including the 502 it answers when its own origin pull fails), or a
 *     transport failure that was not our own deadline. This is the only verdict
 *     that may write a classroom off.
 *   - `aborted` — OUR deadline expired. Deliberately not a fault of the origin:
 *     a cold pull legitimately outruns a two second thumbnail budget, and
 *     treating our own impatience as an outage would write off a classroom that
 *     is merely slow — and keep it written off for five minutes.
 *
 * A leg that never RAN records nothing at all: the delivery layer switched off,
 * no map row for this path, the per-render circuit already open, or the read
 * out of budget before the fetch began. None of those say anything about
 * reachability, and none may condemn a classroom.
 */
type WorkerLegOutcome = 'miss' | 'refused' | 'unreachable' | 'aborted';

interface TextReadTrace {
  worker?: WorkerLegOutcome;
}

/**
 * A Worker refusal, classified. See `WorkerLegOutcome`.
 *
 * The 502 is the important one and the reason this is not simply "not ok": it
 * is what the Worker answers when its OWN origin pull fails, which is exactly
 * the shape of a content repo that has gone private or been deleted.
 */
function workerVerdictFor(status: number): WorkerLegOutcome {
  if (status === 404) return 'miss';
  if (status === 403 || status >= 500) return 'unreachable';
  return 'refused';
}

/**
 * Did WE give up, or did the origin?
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` and an explicit `abort()`
 * with an `AbortError`; either way the deadline that expired is one set in this
 * file, and nothing has been learned about the upstream. Distinguishing them
 * from a refused socket is what keeps a slow classroom from being written off
 * as a broken one.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}


/**
 * Reject after `ms`, so a call with no cancellation of its own cannot hold a
 * render open.
 *
 * The losing promise is NOT cancelled — `ContentService.getContent` takes no
 * `AbortSignal`, so the underlying request keeps running to completion and its
 * result is discarded. That is the honest trade: the render stops waiting, the
 * socket does not. Its rejection is swallowed so a late failure cannot surface
 * as an unhandled rejection after the caller has moved on.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms).unref?.()
    ),
  ]);
}

/**
 * One repo file's TEXT, through the delivery layer when it can be.
 *
 * ## The problem this exists for
 *
 * Images have gone through the Worker by blob sha for a while; text had not.
 * A deck's `index.html` was read CDN-first from `{org}.github.io`, which lags a
 * push by minutes (a rapid second save can ERROR the Pages build and stretch
 * that further) — so an instructor saved a deck, opened `/present`, and was
 * shown the previous version of their own slides.
 *
 * Reading it by SHA removes the question. The asset map holds the sha the last
 * write produced, the Worker is keyed by content, and a URL naming a sha can
 * only ever return that sha's bytes. Freshness stops being a cache policy and
 * becomes a property of the address — which is why the save paths write the
 * returned sha into the map (`recordContentAsset`) the moment a commit lands.
 *
 * ## The tier
 *
 * Always `week`, whoever is reading. This is a server-to-server fetch: the
 * bytes are handed to a loader that has already done its own authorization, and
 * they are never given to a browser as a URL. The tier here therefore decides
 * nothing about access — it only picks an expiry bucket and a `Cache-Control`,
 * and a week is the right middle: long enough that one signature serves a
 * lecture hall's worth of `/follow` reads out of the edge, short enough not to
 * mint the 30-day bucket for content nobody published.
 *
 * ## When the map cannot answer
 *
 * See `TextFallback`. The default inverts the order this replaces; a fan-out
 * asks for `cdn-only`; a caller that needs its own error semantics asks for
 * `none`.
 *
 * ## Never throws
 *
 * This sits on the render path of every deck and page. Every failure — a 502
 * from the Worker, a GitHub rate limit, a DNS blip, a timeout — degrades to the
 * next tier and finally to `null`, which callers already render as "content
 * unavailable". An exception here would be a 500 on a page whose bytes are one
 * tier away.
 */
export async function fetchContentText(
  ctx: TextReadContext,
  repoPath: string,
  opts: {
    label?: string;
    skipCache?: boolean;
    fallback?: TextFallback;
    budget?: TextReadBudget;
    /**
     * Per-leg deadline, overriding `TEXT_FETCH_TIMEOUT_MS`.
     *
     * For a caller whose read is worth LESS than the default budget, not more.
     * A thumbnail is the case: it is decorative, and its loader is one of
     * nineteen the browser is running at six-at-a-time, so a leg that waits the
     * full six seconds turns one unreadable classroom into a page that dribbles
     * in over minutes. Two seconds is generous for a read that is expected to
     * hit the edge and pointless to extend for one that will not.
     */
    deadlineMs?: number;
    /**
     * This read is decorative — its absence costs a placeholder, not an error.
     *
     * Decorative reads consult the unreachable-classroom window and return
     * `null` immediately when it is open, so one classroom's broken repo costs
     * one timeout per window instead of one per file. Reads that a person is
     * actually waiting on leave this off and always make the attempt; see
     * `unreachableClassrooms`.
     */
    decorative?: boolean;
  } = {}
): Promise<ContentText | null> {
  const path = normalizeRepoRelative(repoPath);
  if (!path) return null;

  // Already known unreachable, and this read is decorative. No map lookup, no
  // socket, no wait — the answer was established by the read that paid for it.
  if (opts.decorative && isClassroomUnreachable(ctx.classroom.id)) {
    logTextRead(opts.label, path, ctx.classroom.id, 'unreachable');
    return null;
  }

  const deadlineMs = opts.deadlineMs ?? TEXT_FETCH_TIMEOUT_MS;
  const fallback = opts.fallback ?? 'api-then-cdn';
  const trace: TextReadTrace = {};
  const viaWorker = await readTextThroughWorker(ctx, path, deadlineMs, trace, opts.budget);
  const result =
    viaWorker ??
    (fallback === 'none' ? null : await readTextFromGitHub(ctx, path, fallback, deadlineMs, opts));

  // Nothing produced content, and the Worker leg says the repo cannot be read
  // through it at all. That is a classroom-level fault, so record it once and
  // let the decorative reads behind this one skip the wait.
  //
  // Independent of what the CDN leg said, on purpose. `{org}.github.io` answers
  // 404 for every case this exists for — repo private, repo deleted, Pages
  // never published — so a rule that needed BOTH legs to fail armed for none of
  // them. And a Worker 404, or our own deadline expiring, is not this: see
  // `WorkerLegOutcome`.
  if (!result && trace.worker === 'unreachable') {
    rememberUnreachable(ctx.classroom.id, path);
  }

  logTextRead(opts.label, path, ctx.classroom.id, result?.source ?? 'none');
  return result;
}

/**
 * The signed URL one repo file's TEXT is read at — the ONE place that shape is
 * decided.
 *
 * Extracted rather than inlined because two callers now have to agree on it
 * byte for byte. The read (`readTextThroughWorker`) mints it to fetch the file;
 * the warm (`warmContentText`) mints it to fill the cache the read will hit.
 * The Worker's R2 key is content-addressed and its edge entry is keyed by URL,
 * so a warm that differed by so much as a tier would fill an entry no reader
 * ever asks for — a cache warmed for nobody, and no way to tell from either
 * side that it had happened.
 *
 * Always `week`, and always the classroom's current key version: a
 * server-to-server read hands its bytes to a loader that has already done its
 * own authorization, so the tier picks an expiry bucket and a `Cache-Control`
 * and decides nothing about access. See `fetchContentText`.
 */
async function signTextUrl(
  classroom: ResolveClassroom,
  env: { origin: string; master: string },
  sha: string,
  ext: string
): Promise<string> {
  return signBlobUrl(
    env.origin,
    // Server-to-server: `week` names the cache bucket, not the reader.
    {
      master: env.master,
      classroomId: classroom.id,
      keyVersion: classroom.content_key_version,
      tier: 'week',
    },
    { sha, ext }
  );
}

/**
 * How long a warm may run before it is abandoned.
 *
 * Far longer than a read's budget, and for the opposite reason: nobody is
 * waiting on this. A cold pull is a token mint against the webapp plus a GitHub
 * blob read, and on staging — where the webapp autostops and the token endpoint
 * can be a cold start — that has been measured in the tens of seconds. A warm
 * that gave up at the read's six seconds would abandon precisely the pulls that
 * are slow enough to be worth warming.
 *
 * It is a bound rather than an absence of one so a hung origin cannot leave a
 * socket open behind every save for as long as the process lives.
 */
const WARM_FETCH_TIMEOUT_MS = 30_000;

/**
 * Pull each just-saved text file through the Worker, so the next reader does
 * not have to.
 *
 * ## Why this exists
 *
 * Every save mints new shas, and a sha the Worker has never seen is a cold
 * pull: R2 misses, the Worker asks the webapp for an installation token, then
 * asks GitHub for the blob. Measured on staging that is 4–25 seconds of Worker
 * wall time (about 5ms of CPU — it is all waiting), against 100–300ms for an
 * image that is already in R2. The app gives the Worker `TEXT_FETCH_TIMEOUT_MS`
 * and then falls back, so the person who opens a deck right after saving it
 * waits out the budget and is then served through GitHub — a save that appears
 * to hang for six seconds, every time, for the FIRST reader only.
 *
 * The first reader is the wrong person to pay that. The save already knows
 * exactly which shas are new, and it is already talking to the network, so this
 * moves the cold pull onto the save's own tail where nobody is waiting: by the
 * time a reader arrives the bytes are in R2 and the read is an edge hit.
 *
 * ## What it does NOT do
 *
 * It is not correctness. Every warm is allowed to fail — a 502, a timeout, a
 * classroom whose row the map has not caught up on — and the read path is
 * unchanged when it does: Worker, then contents API, then the CDN. Nothing
 * downstream may be written to assume a warm ran.
 *
 * Which is why it never rejects and never throws. It is called WITHOUT `await`
 * from the save paths, so a rejection would surface as an unhandled rejection
 * some time after the save had already returned successfully — a save reported
 * as broken because a cache fill was slow.
 *
 * @param ctx      the classroom being saved into
 * @param paths    the repo-relative TEXT files the save just committed and
 *                 recorded (`deck.json`, `index.html`, `content.json`). Binary
 *                 uploads are not warmed: nobody blocks a render on them, and
 *                 they are megabytes rather than kilobytes.
 */
export async function warmContentText(ctx: TextReadContext, paths: string[]): Promise<void> {
  // The same two gates the read path opens with. A classroom that is not on the
  // delivery layer has no Worker cache to warm, and a deployment that cannot
  // sign has no URL to warm it at.
  if (!isContentDeliveryEnabled(ctx.classroom)) return;
  const env = deliveryEnv();
  if (!env) return;

  // Deduped: `saveDeck` writes `deck.json` and `index.html` in one commit, and
  // a caller that passed the same path twice should not pull it twice.
  const unique = [
    ...new Set(
      paths.map(path => normalizeRepoRelative(path)).filter((path): path is string => path !== null)
    ),
  ];
  if (unique.length === 0) return;

  await Promise.all(unique.map(path => warmOneTextFile(ctx.classroom, env, path)));
}

/**
 * One file's warm. Swallows everything, by design — see `warmContentText`.
 *
 * The body is READ rather than cancelled. The Worker streams the origin body to
 * its caller while a tee'd copy goes into R2, and dropping our half early is a
 * needless race against the write this whole function exists to cause. These
 * are kilobyte documents, so reading them costs nothing worth saving.
 */
async function warmOneTextFile(
  classroom: ResolveClassroom,
  env: { origin: string; master: string },
  path: string
): Promise<void> {
  try {
    const ext = extensionOf(path);
    if (!ext) return;

    // The row the save just wrote. No `ensureMap` here: a warm that had to
    // refresh the map would be warming a sha the save did not produce, and the
    // save awaited its own `recordContentAsset` before calling us.
    const asset = await lookupContentAsset(classroom.id, path);
    if (!asset || asset.type !== 'blob') return;

    const url = await signTextUrl(classroom, env, asset.sha, ext);
    const response = await fetch(url, { signal: AbortSignal.timeout(WARM_FETCH_TIMEOUT_MS) });
    await response.arrayBuffer();

    // eslint-disable-next-line no-console
    console.debug(
      `[contentDelivery] warm ${path} sha=${asset.sha} status=${response.status} ` +
        `classroom=${classroom.id}`
    );
  } catch (error) {
    // Debug, not warn: a failed warm is a cache that stayed cold, which the
    // read path already handles. Logging it at a level operators are told to
    // search would turn a latency optimization into a source of alarms.
    // eslint-disable-next-line no-console
    console.debug(
      `[contentDelivery] warm failed for ${path} (classroom ${classroom.id}):`,
      error instanceof Error ? error.message : error
    );
  }
}

/** The map lookup + signed fetch. Null means "not through the Worker" — never an error. */
async function readTextThroughWorker(
  ctx: TextReadContext,
  path: string,
  deadlineMs: number,
  trace: TextReadTrace,
  budget?: TextReadBudget
): Promise<ContentText | null> {
  if (!isContentDeliveryEnabled(ctx.classroom)) return null;
  // A previous probe in this render already found the Worker unreachable.
  // Paying the timeout again would only make one stalled render into several.
  if (budget?.workerUnavailable) return null;
  const env = deliveryEnv();
  if (!env) return null;

  const ext = extensionOf(path);
  if (!ext) return null;

  let asset: ContentAssetRecord | null;
  try {
    // Bounded: a stale map turns this into three GitHub calls, and a slow
    // GitHub must cost a fallback rather than a held-open render. Never longer
    // than the caller's own budget — a decorative read that asked for two
    // seconds must not spend four of them here before its fetch begins.
    await withDeadline(
      ensureMap(ctx.classroom.id),
      Math.min(ENSURE_MAP_TIMEOUT_MS, deadlineMs),
      'map refresh'
    ).catch(error => {
      console.warn(
        `[contentDelivery] Map refresh gave up for classroom ${ctx.classroom.id}:`,
        error instanceof Error ? error.message : error
      );
    });
    asset = await lookupContentAsset(ctx.classroom.id, path);
  } catch (error) {
    // The map itself is unreachable, which is not the Worker's fault — do not
    // trip the circuit, just fall back for this path.
    console.warn(
      `[contentDelivery] Map lookup failed for ${path} (classroom ${ctx.classroom.id}):`,
      error instanceof Error ? error.message : error
    );
    return null;
  }

  // No row, or a TREE row — a directory is not a file. Either way there is no
  // blob to sign. A MISS, deliberately not a circuit trip: this path having no
  // row says nothing about the next path the caller probes.
  if (!asset || asset.type !== 'blob') return null;

  try {
    const url = await signTextUrl(ctx.classroom, env, asset.sha, ext);

    const response = await fetch(url, { signal: AbortSignal.timeout(deadlineMs) });
    if (!response.ok) {
      // A refusal is an ANSWER, not a dead origin: the Worker is up and said
      // no. Fall back for this path and leave the per-render circuit closed.
      // What KIND of no it was decides the classroom write-off — see
      // `workerVerdictFor`.
      trace.worker = workerVerdictFor(response.status);
      console.warn(
        `[contentDelivery] Worker returned ${response.status} for ${path} ` +
          `(classroom ${ctx.classroom.id}); falling back`
      );
      return null;
    }

    return { text: await response.text(), sha: asset.sha, source: 'worker' };
  } catch (error) {
    // A throw here is transport — a timeout, a DNS failure, a refused socket —
    // and it is about the ORIGIN rather than this file. Trip the circuit so the
    // rest of this render does not queue up behind the same dead connection.
    //
    // The circuit trips for OUR deadline too (one render that has already
    // outrun its budget will not do better on the next path), but the
    // classroom-level write-off does not: a cold pull outrunning a two second
    // thumbnail budget is a slow repo, not an unreadable one, and five minutes
    // of blanked thumbnails is far too much to conclude from our own
    // impatience.
    if (budget) budget.workerUnavailable = true;
    trace.worker = isAbortError(error) ? 'aborted' : 'unreachable';
    console.warn(
      `[contentDelivery] Worker text read failed for ${path} (classroom ${ctx.classroom.id}); ` +
        'skipping the Worker for the rest of this read:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * The fallbacks, in the order that favours freshness: contents API, then the
 * Pages CDN.
 *
 * The API read is authenticated and always sees the current commit; the CDN is
 * a build artifact minutes behind it. `cdn-only` skips the API leg entirely —
 * see `TextFallback`.
 *
 * The CDN tier is marked for deletion with the rest of Phase 4: by then every
 * classroom is on the layer, and a repo that has gone private serves nothing
 * from `github.io` anyway.
 */
async function readTextFromGitHub(
  ctx: TextReadContext,
  path: string,
  fallback: TextFallback,
  deadlineMs: number,
  opts: { skipCache?: boolean }
): Promise<ContentText | null> {
  const orgLogin = ctx.classroom.git_organization.login;
  const repo = ctx.classroom.content_repo;
  if (!orgLogin || !repo) return null;

  // No trace to write. Neither of these legs may condemn a classroom: the CDN
  // answers 404 for a private, deleted or never-published repo alike, and the
  // contents API is reached only after the Worker has already had its say. See
  // `unreachableClassrooms`.
  if (fallback !== 'cdn-only') {
    try {
      const file = await withDeadline(
        ContentService.getContent({
          orgLogin,
          repo,
          path,
          ...(opts.skipCache ? { skipCache: true } : {}),
        }),
        deadlineMs,
        'contents API read'
      );
      if (file?.content) return { text: file.content, sha: file.sha ?? null, source: 'api' };
    } catch (error) {
      // A 403 (no access), a 5xx, or our own deadline. Not an answer.
      console.warn(
        `[contentDelivery] API text read failed for ${repo}/${path}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // DEPRECATED — Phase 4 removes this tier entirely. It is last rather than
  // first (which is how this read used to be ordered) because GitHub Pages lags
  // a push by minutes, and the whole point of the map-first path above is that
  // a save is visible the instant it returns.
  try {
    const response = await fetch(`https://${orgLogin}.github.io/${repo}/${path}`, {
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (response.ok) return { text: await response.text(), sha: null, source: 'cdn' };
  } catch (error) {
    console.warn(
      `[contentDelivery] CDN text read failed for ${repo}/${path}:`,
      error instanceof Error ? error.message : error
    );
  }

  return null;
}

/**
 * Where a render's text came from, one line per render rather than per file.
 *
 * The question these answer — "is this deployment actually serving text from
 * the Worker, and for which classrooms?" — is asked of a rollout, not of a
 * file, and a page that probes three paths should not write three lines to
 * answer it once. Consecutive reads carrying the same label, classroom and
 * source are folded into one line with a count, flushed when any of the three
 * changes.
 *
 * Debug, not warn: the repo's `no-console` rule allows only warn and error
 * precisely so that ordinary chatter does not land at a level an operator is
 * told to search. This stays below that line on purpose.
 */
let pendingLog: {
  key: string;
  label: string;
  classroomId: string;
  source: string;
  n: number;
} | null = null;

function logTextRead(
  label: string | undefined,
  path: string,
  classroomId: string,
  source: string
): void {
  const name = label ?? 'read';
  const key = `${name}|${classroomId}|${source}`;
  if (pendingLog && pendingLog.key === key) {
    pendingLog.n += 1;
    return;
  }
  flushTextReadLog();
  pendingLog = { key, label: name, classroomId, source, n: 1 };
  // Emitted on the next tick so a render's remaining probes can fold into it;
  // a render is a handful of awaits, so this always lands within the request.
  queueMicrotask(flushTextReadLog);
  void path;
}

function flushTextReadLog(): void {
  if (!pendingLog) return;
  const { label, classroomId, source, n } = pendingLog;
  pendingLog = null;
  // eslint-disable-next-line no-console
  console.debug(
    `[contentDelivery] text ${label} source=${source} files=${n} classroom=${classroomId}`
  );
}

/**
 * A signed URL of OURS → the repo path behind it; anything else unchanged.
 *
 * This is what keeps the derivation from leaking back into storage. The editor
 * renders a signed URL, the browser hands that same string back on save, and
 * without this pass it would be committed into `content.json` — freezing
 * today's signature and this viewer's tier into the document forever.
 *
 * Scoped to THIS classroom's own URLs: a signed URL for another classroom is
 * left alone, because its sha means nothing in this classroom's map and
 * "resolving" it would silently retarget the reference.
 *
 * Deliberately NOT behind the per-classroom gate. Every other entry point is,
 * because they MINT URLs and the flag decides whether this classroom's URLs
 * should be minted at all. This one only ever removes one — so it has to keep
 * working after the flag is switched back off, or the signed URLs already
 * sitting in an open editor would be committed on the next save. A reference
 * that is not a signed URL of ours costs one cheap parse and returns unchanged.
 */
export async function canonicalizeAssetRef(ctx: ResolveContext, urlOrRef: string): Promise<string> {
  if (typeof urlOrRef !== 'string' || urlOrRef.length === 0) return urlOrRef;

  // A `/missing/` placeholder carries its own reference — no map read needed,
  // and none possible: the placeholder exists precisely because the map had no
  // row. Undoing it restores the reference a later sync can still repair.
  const missing = parseMissingUrl(ctx, urlOrRef);
  if (missing !== null) return missing;

  const parsed = parseContentUrl(urlOrRef);
  if (!parsed) return urlOrRef;
  if (parsed.classroomId !== ctx.classroom.id) return urlOrRef;

  // A signed THEME url reaches storage through a deck's `<link href>` or an
  // inline `url()`, and it expires exactly like a blob url does. Its repo path
  // is fully determined by the URL — theme name plus relative path — so it
  // needs no map read at all.
  if (parsed.kind === 'theme') {
    return parsed.relPath
      ? `${THEMES_FOLDER}/${parsed.theme}/${parsed.relPath}`
      : `${THEMES_FOLDER}/${parsed.theme}`;
  }

  const asset = await lookupContentAssetBySha(ctx.classroom.id, parsed.sha);
  if (!asset) {
    // The sha is gone from the map (the file was deleted, or the map re-synced
    // mid-edit). Leaving the signed URL in place would store it; there is no
    // path to store instead, so keep the caller's string and let the missing
    // asset surface as a broken image rather than as a silent content change.
    console.warn(
      `[contentDelivery] No path for sha ${parsed.sha} in classroom ${ctx.classroom.id}`
    );
    return urlOrRef;
  }

  return asset.path;
}

/**
 * Batched `canonicalizeAssetRef`.
 *
 * The save paths canonicalize a whole document at once, and doing that one
 * `await` at a time would serialize a lookup per image. Every input ref appears
 * in the result, including the ones that come back unchanged, so a caller can
 * look up unconditionally.
 */
export async function canonicalizeMany(
  ctx: ResolveContext,
  refs: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter(ref => typeof ref === 'string' && ref.length > 0))];
  const canonical = new Map<string, string>();

  await Promise.all(
    unique.map(async ref => {
      canonical.set(ref, await canonicalizeAssetRef(ctx, ref));
    })
  );

  return canonical;
}

/**
 * Does this reference name something in THIS classroom's content repo?
 *
 * Synchronous and map-free — it answers from the shape of the string alone,
 * which is all a caller deciding "is this ours to rewrite" needs. Three shapes
 * count: a repo-relative path, one of the legacy absolute URLs into this
 * classroom's repo, and a signed delivery URL minted for this classroom.
 *
 * The save paths use it to decide whose `srcset` they may strip. An author's
 * own responsive `<img srcset>` pointing at some external CDN is content, and
 * removing it would be a silent edit of their slide.
 */
export function isOwnAssetRef(ctx: ResolveContext, ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  if (toRepoPath(ctx, ref) !== null) return true;
  // The placeholder is derived from one of ours and belongs to the same set —
  // leaving it out here would let a stale `srcset` survive around one.
  if (parseMissingUrl(ctx, ref) !== null) return true;
  const parsed = parseContentUrl(ref);
  return parsed !== null && parsed.classroomId === ctx.classroom.id;
}

/**
 * Refresh the asset map if it is stale, and never let that fail a render.
 *
 * `ensureContentAssets` reaches GitHub on a miss, and GitHub is allowed to be
 * down. A failed sync means the map stays as it is — stale, or empty — and the
 * refs that cannot be resolved fall back on their own.
 */
async function ensureMap(classroomId: string): Promise<void> {
  try {
    await ensureContentAssets(classroomId, { maxAgeMs: ENSURE_MAX_AGE_MS });
  } catch (error) {
    console.warn(
      `[contentDelivery] Asset map refresh failed for classroom ${classroomId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
