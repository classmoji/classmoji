import { collectBlockAssetRefs, isBlockLike, mapBlockAssetRefs } from '@classmoji/utils';
import { ClassmojiService } from './db.server.ts';

/**
 * Page-side asset resolution: the policy half of the two-pass rewrite.
 *
 * The tree walk itself lives in `@classmoji/utils` (pure, unit-tested); what is
 * here is everything that needs a classroom, a viewer tier, and the delivery
 * service — building a resolve context, batching a document's references into
 * one resolve, and canonicalizing on the way back in.
 */

/** The classroom fields a resolve context needs. */
export type AssetClassroom = {
  id: string;
  content_key_version: number;
  content_repo: string;
  content_delivery_enabled?: boolean | null;
  git_organization?: { login?: string | null } | null;
};

export type AssetResolveContext = {
  classroom: {
    id: string;
    content_key_version: number;
    content_repo: string;
    content_delivery_enabled: boolean;
    git_organization: { login: string };
  };
  tier: 'public' | 'enrolled' | 'draft';
};

/**
 * Build a resolve context, or null when this classroom cannot be served.
 *
 * Null is a normal state, not a failure: a classroom with no content repo or no
 * git organization has no assets to resolve, and every caller degrades to the
 * stored references — which is exactly what the page did before this existed.
 */
export function assetResolveContext(
  classroom: AssetClassroom | null | undefined,
  tier: AssetResolveContext['tier']
): AssetResolveContext | null {
  const login = classroom?.git_organization?.login;
  if (!classroom?.content_repo || !login) return null;
  return {
    classroom: {
      id: classroom.id,
      content_key_version: classroom.content_key_version ?? 0,
      content_repo: classroom.content_repo,
      // A row loaded without the column reads as off, which is the safe
      // direction: the resolvers then hand back stored references, exactly as
      // they did before the delivery layer existed.
      content_delivery_enabled: classroom.content_delivery_enabled === true,
      git_organization: { login },
    },
    tier,
  };
}

/**
 * Resolve every reference in a document, for the client.
 *
 * `assets` is `{ storedRef: signedUrl }` and `srcSets` is
 * `{ storedRef: srcset }` — both keyed the same way, on purpose. The blocks
 * hold the stored reference and nothing else; asking one of them to look itself
 * up by its signed URL would mean reproducing a signature, which means
 * reproducing a clock, an expiry bucket and a tier.
 *
 * ONE service call, not two. Two would pay for two asset-map reads and, worse,
 * read the clock twice: expiries are bucketed, so two passes that straddle a
 * bucket boundary mint different URLs for the same file, and every srcset would
 * be silently dropped for exactly the viewers on the shortest bucket — staff,
 * on the draft tier. `resolveDelivery` mints both under one `now`.
 *
 * Empty (never throws, never rewrites the blocks) when the classroom is
 * unservable or the delivery layer is off, so the client falls through to the
 * stored reference on every lookup miss.
 */
export async function resolveDocumentAssets(
  ctx: AssetResolveContext | null,
  blocks: unknown,
  extraRefs: Array<string | null | undefined> = []
): Promise<{ assets: Record<string, string>; srcSets: Record<string, string> }> {
  if (!ctx) return { assets: {}, srcSets: {} };

  const refs = [
    ...collectBlockAssetRefs(blocks),
    ...extraRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
  ];
  if (refs.length === 0) return { assets: {}, srcSets: {} };

  const { urls, srcSets } = await ClassmojiService.contentDelivery.resolveDelivery(ctx, refs, {
    srcSets: true,
  });

  const assets: Record<string, string> = {};
  for (const [ref, url] of urls) {
    // Only entries that actually changed: a passthrough would just be noise in
    // the loader payload, and the client already falls back to the ref itself.
    if (url !== ref) assets[ref] = url;
  }

  const sets: Record<string, string> = {};
  for (const [ref, set] of srcSets) sets[ref] = set.srcset;

  return { assets, srcSets: sets };
}

/**
 * Replace any signed URL in a document with the repo path behind it.
 *
 * Defense in depth for the save path. The editor is told to keep the stored
 * reference in the block and to display the signed URL separately, but a block
 * created by a paste, an older client bundle, or a future custom block could
 * still carry one — and a signed URL committed to content.json is a reference
 * that stops following its file and expires.
 */
export async function canonicalizeDocumentAssets<T>(
  ctx: AssetResolveContext | null,
  blocks: T
): Promise<T> {
  if (!ctx) return blocks;

  const refs = [...new Set(collectBlockAssetRefs(blocks))];
  if (refs.length === 0) return blocks;

  const canonical = new Map<string, string>();
  await Promise.all(
    refs.map(async ref => {
      canonical.set(ref, await ClassmojiService.contentDelivery.canonicalizeAssetRef(ctx, ref));
    })
  );

  return mapBlockAssetRefs(blocks, ref => canonical.get(ref) ?? ref);
}

/**
 * The same canonicalization over an ops payload.
 *
 * An ops save transmits only the blocks that changed, so the whole-document
 * pass never sees them — and a newly inserted image block is precisely the one
 * most likely to be carrying a freshly minted display URL.
 */
export async function canonicalizeOpsAssets<T>(
  ctx: AssetResolveContext | null,
  ops: T
): Promise<T> {
  if (!ctx || !Array.isArray(ops)) return ops;

  // An op is not a block — it is a wrapper whose `block` / `blocks` field holds
  // one. So the tree walk is applied to those fields, not to the op itself.
  const payloads = ops.flatMap((op: unknown) =>
    isBlockLike(op) ? [op.block, op.blocks].filter(part => part != null) : []
  );

  const refs = [...new Set(payloads.flatMap(collectBlockAssetRefs))];
  if (refs.length === 0) return ops;

  const canonical = new Map<string, string>();
  await Promise.all(
    refs.map(async ref => {
      canonical.set(ref, await ClassmojiService.contentDelivery.canonicalizeAssetRef(ctx, ref));
    })
  );
  const map = (ref: string) => canonical.get(ref) ?? ref;

  return ops.map((op: unknown) => {
    if (!isBlockLike(op)) return op;
    const block = op.block == null ? op.block : mapBlockAssetRefs(op.block, map);
    const blocks = op.blocks == null ? op.blocks : mapBlockAssetRefs(op.blocks, map);
    if (block === op.block && blocks === op.blocks) return op;
    return {
      ...op,
      ...(op.block == null ? {} : { block }),
      ...(op.blocks == null ? {} : { blocks }),
    };
  }) as T;
}

/** Canonicalize one standalone reference (the page cover image). */
export async function canonicalizeAssetRef(
  ctx: AssetResolveContext | null,
  ref: string | null | undefined
): Promise<string | null | undefined> {
  if (!ctx || typeof ref !== 'string' || ref.length === 0) return ref;
  return ClassmojiService.contentDelivery.canonicalizeAssetRef(ctx, ref);
}
