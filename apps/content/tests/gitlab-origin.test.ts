import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabOrigin } from '../src/origins/gitlab.ts';
import { originFor } from '../src/origins/select.ts';
import { GitHubOrigin } from '../src/origins/github.ts';
import { OriginAuthError } from '../src/origins/types.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ref = {
  org: 'dept',
  repo: 'content-cs1',
  token: 'glpat-x',
  provider: 'GITLAB' as const,
  apiBase: 'https://gitlab.example.edu',
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });

describe('originFor', () => {
  it('picks Gitlab only when the token says so', () => {
    expect(originFor({ provider: 'GITLAB' })).toBeInstanceOf(GitLabOrigin);
    expect(originFor({})).toBeInstanceOf(GitHubOrigin);
  });
});

describe('GitLabOrigin.fetchBlob', () => {
  it('reads raw blob bytes from the configured instance', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new GitLabOrigin().fetchBlob({ ...ref, sha: 'abc' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(
      'https://gitlab.example.edu/api/v4/projects/dept%2Fcontent-cs1/repository/blobs/abc/raw'
    );
    expect(init.headers.Authorization).toBe('Bearer glpat-x');
  });
});

describe('GitLabOrigin.fetchTree', () => {
  it('lists a theme folder relative to it, and trusts it when its id is the signed sha', async () => {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get('path') === '.slidesthemes' && !u.searchParams.get('recursive')) {
        return json([{ id: 'tree1', name: 'dark', type: 'tree', path: '.slidesthemes/dark' }]);
      }
      return json([
        { id: 'b1', name: 'theme.json', type: 'blob', path: '.slidesthemes/dark/theme.json' },
        { id: 't2', name: 'lib', type: 'tree', path: '.slidesthemes/dark/lib' },
        { id: 'b2', name: 'a.css', type: 'blob', path: '.slidesthemes/dark/lib/a.css' },
      ]);
    }) as unknown as typeof fetch;

    const listing = await new GitLabOrigin().fetchTree({
      ...ref,
      treeSha: 'tree1',
      path: '.slidesthemes/dark',
    });
    expect(listing).toEqual({
      truncated: false,
      entries: [
        { path: 'theme.json', sha: 'b1', type: 'blob' },
        { path: 'lib/a.css', sha: 'b2', type: 'blob' },
      ],
    });
  });

  it('marks a folder that moved since signing as not cacheable', async () => {
    globalThis.fetch = (async (url: string) =>
      new URL(url).searchParams.get('recursive')
        ? json([])
        : json([
            { id: 'newer', name: 'dark', type: 'tree', path: '.slidesthemes/dark' },
          ])) as unknown as typeof fetch;

    const listing = await new GitLabOrigin().fetchTree({
      ...ref,
      treeSha: 'signed',
      path: '.slidesthemes/dark',
    });
    expect(listing.truncated).toBe(true);
  });

  it('raises OriginAuthError on a 401 so the token is refreshed', async () => {
    globalThis.fetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(
      new GitLabOrigin().fetchTree({ ...ref, treeSha: 'x', path: '.slidesthemes/dark' })
    ).rejects.toBeInstanceOf(OriginAuthError);
  });
});
