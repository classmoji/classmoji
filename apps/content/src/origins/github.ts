import {
  OriginAuthError,
  OriginError,
  type BlobRef,
  type OriginAdapter,
  type TreeEntry,
  type TreeListing,
  type TreeRef,
} from './types.ts';

const API = 'https://api.github.com';
const USER_AGENT = 'classmoji-content';
const API_VERSION = '2022-11-28';

/** GitHub's Git blob API stops serving raw bytes above 100 MB. */
const MAX_PROXY_BYTES = 100 * 1024 * 1024;

interface GitTreeResponse {
  tree?: Array<{ path?: string; sha?: string; type?: string }>;
  truncated?: boolean;
}

function headers(token: string, accept: string): Headers {
  return new Headers({
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  });
}

export class GitHubOrigin implements OriginAdapter {
  readonly canPresign = false;

  readonly maxProxyBytes = MAX_PROXY_BYTES;

  /**
   * Raw blob bytes. The response is returned unread so the caller can stream
   * it; a 401 is handed back as-is so the caller can refresh the token.
   */
  async fetchBlob(ref: BlobRef): Promise<Response> {
    return fetch(`${API}/repos/${ref.org}/${ref.repo}/git/blobs/${ref.sha}`, {
      headers: headers(ref.token, 'application/vnd.github.raw+json'),
    });
  }

  async fetchTree(ref: TreeRef): Promise<TreeListing> {
    const response = await fetch(
      `${API}/repos/${ref.org}/${ref.repo}/git/trees/${ref.treeSha}?recursive=1`,
      { headers: headers(ref.token, 'application/vnd.github+json') }
    );

    if (response.status === 401)
      throw new OriginAuthError('github rejected the installation token');
    if (!response.ok)
      throw new OriginError(response.status, `github tree ${ref.treeSha}: ${response.status}`);

    const payload = (await response.json()) as GitTreeResponse;
    const truncated = payload.truncated === true;
    if (truncated) {
      console.warn(`[content] truncated tree listing for ${ref.org}/${ref.repo}@${ref.treeSha}`);
    }

    const entries: TreeEntry[] = [];
    for (const entry of payload.tree ?? []) {
      if (entry.type === 'blob' && entry.path && entry.sha) {
        entries.push({ path: entry.path, sha: entry.sha, type: 'blob' });
      }
    }
    return { entries, truncated };
  }
}
