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
import {
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
 *     and for the instructor previewing a draft.
 *
 * Everything here is therefore pure derivation, and the save paths run
 * `canonicalizeAssetRef` to make sure the derivation never leaks back into
 * storage.
 */

/** Access tier a render mints URLs for. See @classmoji/content-signing. */
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
 * Which tier this render is for.
 *
 * `draft` for anyone who can edit and for an explicit preview — they are the
 * only viewers allowed to see content that has not been published, and the
 * short expiry is the price. `public` only for the class-site surface, whose
 * readers are anonymous by definition. Everything else is `enrolled`.
 *
 * Order matters: an instructor previewing their own class site is editing, not
 * browsing, so the draft check comes first.
 */
export function tierFor({
  canEdit,
  preview,
  isPublicSite,
}: {
  canEdit: boolean;
  preview?: boolean;
  isPublicSite?: boolean;
}): ResolveTier {
  if (canEdit || preview) return 'draft';
  if (isPublicSite) return 'public';
  return 'enrolled';
}

function signingContext(ctx: ResolveContext, master: string): SigningContext {
  return {
    master,
    classroomId: ctx.classroom.id,
    keyVersion: ctx.classroom.content_key_version,
    tier: ctx.tier,
  };
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

/** Sign one already-resolved asset, degrading to the legacy ref on refusal. */
async function signAsset(
  ctx: ResolveContext,
  env: { origin: string; master: string },
  ref: string,
  path: string,
  sha: string,
  transform?: ResolveTransform
): Promise<string> {
  const ext = extensionOf(path);
  if (!ext) {
    console.warn(`[contentDelivery] No extension on ${path} (classroom ${ctx.classroom.id})`);
    return ref;
  }
  try {
    return await signBlobUrl(env.origin, signingContext(ctx, env.master), {
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
  transform?: ResolveTransform
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

  return signAsset(ctx, env, ref, path, asset.sha, transform);
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
 * A responsive `{ src, srcset }` for one image reference.
 *
 * Null — not a passthrough string — whenever a responsive set cannot be built
 * (unconfigured, not our repo, unknown to the map, unsignable). The caller
 * needs to tell "here is a srcset" from "there is no srcset", and an unsigned
 * legacy URL is a `src`, not a set.
 *
 * No `sourceWidth` is passed: the asset map stores a file's size in bytes, not
 * its pixel width, so all three rungs are emitted and the pipeline declines to
 * upscale on its own.
 */
export async function resolveAssetSrcSet(
  ctx: ResolveContext,
  ref: string
): Promise<{ src: string; srcset: string } | null> {
  const env = deliveryEnvFor(ctx);
  if (!env) return null;

  const path = toRepoPath(ctx, ref);
  if (!path) return null;

  await ensureMap(ctx.classroom.id);
  const asset = await lookupContentAsset(ctx.classroom.id, path);
  if (!asset || asset.type !== 'blob') {
    console.warn(
      `[contentDelivery] No blob row for "${ref}" (path ${path}) in classroom ${ctx.classroom.id}`
    );
    return null;
  }

  const ext = extensionOf(path);
  if (!ext) return null;

  try {
    return await signSrcSet(env.origin, signingContext(ctx, env.master), { sha: asset.sha, ext });
  } catch (error) {
    console.warn(
      `[contentDelivery] Could not sign a srcset for ${path} in classroom ${ctx.classroom.id}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
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
 * Resolve a whole page's references in one pass.
 *
 * This is the entry point a render should use. Both the map freshness check
 * (a DB read, and possibly a GitHub tree call) and the map lookup itself
 * happen ONCE for the batch rather than once per image — a page with twenty
 * images costs one ensure and one query, not twenty of each.
 *
 * Every input ref appears in the returned map, including the ones that resolve
 * to themselves, so a caller can look up unconditionally.
 */
export async function resolveMany(
  ctx: ResolveContext,
  refs: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter(ref => typeof ref === 'string' && ref.length > 0))];
  const resolved = new Map<string, string>();

  const env = deliveryEnvFor(ctx);
  if (!env) {
    for (const ref of unique) resolved.set(ref, ref);
    return resolved;
  }

  await ensureMap(ctx.classroom.id);

  // Reduce first, look up once. A reference that is not ours resolves to
  // itself without ever reaching the map, and the ones that remain share a
  // single `findMany` — the difference between a forty-image deck costing one
  // query per view and costing forty.
  const wanted = new Map<string, string>();
  for (const ref of unique) {
    const path = toRepoPath(ctx, ref);
    if (path) wanted.set(ref, path);
    else resolved.set(ref, ref);
  }

  if (wanted.size === 0) return resolved;

  const assets = await lookupContentAssets(ctx.classroom.id, [...new Set(wanted.values())]);

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
        resolved.set(ref, missingUrl(env.origin, ctx.classroom.id, ref));
        return;
      }
      resolved.set(ref, await signAsset(ctx, env, ref, path, asset.sha));
    })
  );

  return resolved;
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

  const parsed = parseContentUrl(urlOrRef);
  if (!parsed || parsed.kind !== 'blob') return urlOrRef;
  if (parsed.classroomId !== ctx.classroom.id) return urlOrRef;

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
