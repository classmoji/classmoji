/**
 * Origin adapters: where bytes come from when R2 misses.
 *
 * The Worker knows nothing about a classroom's storage beyond this interface,
 * so a second backend (large media) can be added without touching the router.
 */

export interface OriginRef {
  org: string;
  repo: string;
  token: string;
}

export interface BlobRef extends OriginRef {
  sha: string;
}

export interface TreeRef extends OriginRef {
  treeSha: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob';
}

/**
 * A tree listing plus whether the origin cut it short.
 *
 * `truncated` has to travel with the entries: the listing is stored under an
 * immutable `trees/{treeSha}.json` key, so caching a partial one would 404 the
 * omitted files forever — for every classroom that shares that tree sha.
 */
export interface TreeListing {
  entries: TreeEntry[];
  truncated: boolean;
}

export class OriginError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OriginError';
    this.status = status;
  }
}

/** The origin rejected our credentials — the caller should refresh the token and retry once. */
export class OriginAuthError extends OriginError {
  constructor(message: string) {
    super(401, message);
    this.name = 'OriginAuthError';
  }
}

export interface OriginAdapter {
  /** Whether this origin can hand the browser a direct, time-limited URL. */
  readonly canPresign: boolean;
  /** Above this size, proxying through the Worker is the wrong move. */
  readonly maxProxyBytes: number;
  fetchBlob(ref: BlobRef): Promise<Response>;
  fetchTree(ref: TreeRef): Promise<TreeListing>;
  presign?(ref: BlobRef): Promise<string>;
}

/**
 * Choose a delivery strategy. Blob size is not known ahead of the fetch today,
 * so callers pass `undefined` and always proxy; the branch exists for the media
 * origin, which will know sizes.
 */
export function deliveryStrategy(origin: OriginAdapter, size?: number): 'proxy' | 'presign' {
  if (size === undefined) return 'proxy';
  if (origin.canPresign && size > origin.maxProxyBytes) return 'presign';
  return 'proxy';
}
