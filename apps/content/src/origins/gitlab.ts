import { BLOB_FETCH_TIMEOUT_MS } from './github.ts';
import {
  OriginAuthError,
  OriginError,
  type BlobRef,
  type OriginAdapter,
  type TreeEntry,
  type TreeListing,
  type TreeRef,
} from './types.ts';

/** Past this, proxying through the Worker is the wrong move (same bound as Github). */
const MAX_PROXY_BYTES = 100 * 1024 * 1024;

/** Gitlab caps a tree page at 100 entries. A theme folder never needs more than a few. */
const MAX_TREE_PAGES = 50;

interface GitLabTreeItem {
  id: string;
  name: string;
  type: string;
  path: string;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function projectApi(ref: { apiBase?: string; org: string; repo: string }): string {
  const base = (ref.apiBase || 'https://gitlab.com').replace(/\/+$/, '');
  return `${base}/api/v4/projects/${encodeURIComponent(`${ref.org}/${ref.repo}`)}`;
}

/**
 * The Gitlab origin. Blob ids and tree ids are git object ids on Gitlab too,
 * so the sha-addressed cache keys are shared with the Github origin unchanged.
 *
 * Gitlab cannot list a tree by its own id, only by ref + path, so a theme's
 * listing is read at the default branch under the theme folder and accepted
 * only when that folder's id there IS the signed tree sha. A listing for any
 * other state is used for this request and reported truncated, so it is never
 * stored under a key it does not describe.
 */
export class GitLabOrigin implements OriginAdapter {
  readonly canPresign = false;

  readonly maxProxyBytes = MAX_PROXY_BYTES;

  async fetchBlob(ref: BlobRef): Promise<Response> {
    try {
      return await fetch(`${projectApi(ref)}/repository/blobs/${ref.sha}/raw`, {
        headers: { Authorization: `Bearer ${ref.token}` },
        signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OriginError(502, `gitlab blob ${ref.sha} unreachable: ${describe(error)}`);
    }
  }

  async fetchTree(ref: TreeRef): Promise<TreeListing> {
    if (!ref.path) throw new OriginError(400, 'gitlab tree listing needs a folder path');
    const folder = ref.path.replace(/\/+$/, '');
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    const name = folder.slice(folder.lastIndexOf('/') + 1);

    const siblings = await this.#list(ref, parent, false);
    const current = siblings.find(item => item.type === 'tree' && item.name === name);
    if (!current) throw new OriginError(404, `gitlab tree ${folder}: not found`);

    const items = await this.#list(ref, folder, true);
    const prefix = `${folder}/`;
    const entries: TreeEntry[] = items
      .filter(item => item.type === 'blob' && item.path.startsWith(prefix))
      .map(item => ({ path: item.path.slice(prefix.length), sha: item.id, type: 'blob' }));

    // Moved on since the URL was signed: serve it, never cache it.
    const truncated = current.id !== ref.treeSha;
    if (truncated) {
      console.warn(`[content] gitlab tree ${folder} is ${current.id}, signed ${ref.treeSha}`);
    }
    return { entries, truncated };
  }

  async #list(ref: TreeRef, path: string, recursive: boolean): Promise<GitLabTreeItem[]> {
    const params = new URLSearchParams({ per_page: '100', pagination: 'keyset' });
    if (path) params.set('path', path);
    if (recursive) params.set('recursive', 'true');
    let next: string | null = `${projectApi(ref)}/repository/tree?${params.toString()}`;
    const items: GitLabTreeItem[] = [];

    for (let page = 0; next && page < MAX_TREE_PAGES; page++) {
      let response: Response;
      try {
        response = await fetch(next, {
          headers: { Authorization: `Bearer ${ref.token}` },
          signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        throw new OriginError(502, `gitlab tree ${path} unreachable: ${describe(error)}`);
      }
      if (response.status === 401) throw new OriginAuthError('gitlab rejected the project token');
      if (!response.ok) {
        throw new OriginError(response.status, `gitlab tree ${path}: ${response.status}`);
      }
      items.push(...((await response.json()) as GitLabTreeItem[]));
      const link = response.headers.get('link') ?? '';
      const match = link.split(',').find(part => part.includes('rel="next"'));
      next = match ? (match.match(/<([^>]+)>/)?.[1] ?? null) : null;
    }
    return items;
  }
}
