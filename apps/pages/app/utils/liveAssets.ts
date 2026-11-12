/**
 * Display URLs for assets that arrive on a live page after it loaded.
 *
 * The loader signs the references in the document it read. On a live page,
 * images and files keep arriving — from another editor, an agent, an accepted
 * preview, a push made on GitHub — and their references are not in this
 * browser's display map. The editor's `resolveFileUrl` asks this resolver on a
 * miss; it batches the misses into one `POST /api/asset-urls` and answers each
 * caller with its URL (or null, after which the reference is shown as is).
 *
 * Each reference is asked for once per page load: a reference the server
 * cannot sign is not asked for again on every render.
 *
 * Pure apart from the injected `fetch`, so the unit suite drives it directly.
 */

/** The most references one request carries (the route caps it too). */
export const ASSET_URLS_MAX_REFS = 100;

/** The longest reference worth asking about, in characters. */
export const ASSET_REF_MAX_LENGTH = 2048;

/**
 * The most a request to the route may send: a full batch of the longest
 * references, each character in the six bytes JSON may write it in
 * (`\u0001`), with its quotes and comma, plus 1 KiB for the page id and the
 * brackets. Every batch this resolver builds fits.
 */
export const ASSET_URLS_BODY_MAX_BYTES =
  ASSET_URLS_MAX_REFS * (ASSET_REF_MAX_LENGTH * 6 + 3) + 1024;

/** A reference worth asking the server about: a repo path or `media://`. */
export function isResolvableRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || !ref || ref.length > ASSET_REF_MAX_LENGTH) return false;
  if (ref.startsWith('media://')) return true;
  // Absolute URLs, data:, blob: and protocol-relative URLs are already URLs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return false;
  return true;
}

/** The resolvable, distinct references in `value` (anything else dropped). */
export function resolvableAssetRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isResolvableRef))];
}

export interface ResolvedAssets {
  assets: Record<string, string>;
  srcSets: Record<string, string>;
}

export interface AssetResolver {
  /** The display URL for `ref`, or null when there is none to be had. */
  resolve(ref: string): Promise<string | null>;
}

export function createAssetResolver({
  pageId,
  onResolved,
  fetchImpl = (...args) => fetch(...args),
  delayMs = 40,
  endpoint = '/api/asset-urls',
}: {
  pageId: string;
  /** Every answer, so the caller can remember URLs and candidates. */
  onResolved: (resolved: ResolvedAssets) => void;
  fetchImpl?: typeof fetch;
  delayMs?: number;
  endpoint?: string;
}): AssetResolver {
  const answers = new Map<string, Promise<string | null>>();
  let queue = new Map<string, (url: string | null) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    const batch = queue;
    queue = new Map();
    const refs = [...batch.keys()];
    for (let i = 0; i < refs.length; i += ASSET_URLS_MAX_REFS) {
      const slice = refs.slice(i, i + ASSET_URLS_MAX_REFS);
      let resolved: ResolvedAssets = { assets: {}, srcSets: {} };
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, refs: slice }),
        });
        if (response.ok) {
          const body = (await response.json()) as Partial<ResolvedAssets>;
          resolved = { assets: body.assets ?? {}, srcSets: body.srcSets ?? {} };
        }
      } catch {
        // Unreachable: every ref in the batch shows as it is.
      }
      if (Object.keys(resolved.assets).length > 0 || Object.keys(resolved.srcSets).length > 0) {
        onResolved(resolved);
      }
      for (const ref of slice) batch.get(ref)?.(resolved.assets[ref] ?? null);
    }
  };

  return {
    resolve(ref) {
      if (!isResolvableRef(ref)) return Promise.resolve(null);
      const known = answers.get(ref);
      if (known) return known;
      const answer = new Promise<string | null>(settle => {
        queue.set(ref, settle);
      });
      answers.set(ref, answer);
      if (!timer) timer = setTimeout(() => void flush(), delayMs);
      return answer;
    },
  };
}
