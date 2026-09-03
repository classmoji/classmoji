import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubOrigin } from '../src/origins/github.ts';
import { MediaOrigin } from '../src/origins/media.ts';
import {
  OriginAuthError,
  OriginError,
  deliveryStrategy,
  type OriginAdapter,
} from '../src/origins/types.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ref = { org: 'classmoji', repo: 'content-cs1', token: 'ghs_x' };

describe('GitHubOrigin.fetchBlob', () => {
  it('asks for raw bytes with the documented headers', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new GitHubOrigin().fetchBlob({ ...ref, sha: 'deadbeef' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Headers }];
    expect(url).toBe('https://api.github.com/repos/classmoji/content-cs1/git/blobs/deadbeef');
    expect(init.headers.get('Accept')).toBe('application/vnd.github.raw+json');
    expect(init.headers.get('Authorization')).toBe('Bearer ghs_x');
    expect(init.headers.get('User-Agent')).toBe('classmoji-content');
    expect(init.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('hands a 401 back unread so the caller can refresh the token', async () => {
    globalThis.fetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const response = await new GitHubOrigin().fetchBlob({ ...ref, sha: 'deadbeef' });
    expect(response.status).toBe(401);
  });
});

describe('GitHubOrigin.fetchTree', () => {
  it('keeps only blob entries, dropping trees and submodules', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tree: [
            { path: 'css', sha: 't1', type: 'tree' },
            { path: 'css/site.css', sha: 'b1', type: 'blob' },
            { path: 'vendor', sha: 'c1', type: 'commit' },
            { path: 'broken', type: 'blob' },
          ],
        })
      )) as unknown as typeof fetch;

    const listing = await new GitHubOrigin().fetchTree({ ...ref, treeSha: 'tree1' });
    expect(listing.entries).toEqual([{ path: 'css/site.css', sha: 'b1', type: 'blob' }]);
    expect(listing.truncated).toBe(false);
  });

  it('reports a truncated listing so the caller can refuse to cache it', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          truncated: true,
          tree: [{ path: 'css/site.css', sha: 'b1', type: 'blob' }],
        })
      )) as unknown as typeof fetch;

    const listing = await new GitHubOrigin().fetchTree({ ...ref, treeSha: 'tree1' });
    expect(listing.truncated).toBe(true);
    expect(listing.entries).toHaveLength(1);
  });

  it('requests the recursive listing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tree: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await new GitHubOrigin().fetchTree({ ...ref, treeSha: 'tree1' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      'https://api.github.com/repos/classmoji/content-cs1/git/trees/tree1?recursive=1'
    );
  });

  it('throws an auth error on 401 and a plain origin error otherwise', async () => {
    globalThis.fetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(new GitHubOrigin().fetchTree({ ...ref, treeSha: 't' })).rejects.toBeInstanceOf(
      OriginAuthError
    );

    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(new GitHubOrigin().fetchTree({ ...ref, treeSha: 't' })).rejects.toBeInstanceOf(
      OriginError
    );
  });
});

describe('deliveryStrategy', () => {
  const presignable: OriginAdapter = {
    canPresign: true,
    maxProxyBytes: 1000,
    fetchBlob: async () => new Response(''),
    fetchTree: async () => ({ entries: [], truncated: false }),
    presign: async () => 'https://example.test/signed',
  };

  it('proxies whenever the size is unknown — which is every blob today', () => {
    expect(deliveryStrategy(new GitHubOrigin(), undefined)).toBe('proxy');
    expect(deliveryStrategy(presignable, undefined)).toBe('proxy');
  });

  it('presigns only a known-oversized object on an origin that can', () => {
    expect(deliveryStrategy(presignable, 5000)).toBe('presign');
    expect(deliveryStrategy(presignable, 500)).toBe('proxy');
    expect(deliveryStrategy(new GitHubOrigin(), 5_000_000_000)).toBe('proxy');
  });
});

describe('MediaOrigin', () => {
  it('is a declared seam, not a working backend', async () => {
    const media = new MediaOrigin();
    await expect(media.fetchBlob({ ...ref, sha: 'x' })).rejects.toThrow('not implemented');
    await expect(media.fetchTree({ ...ref, treeSha: 'x' })).rejects.toThrow('not implemented');
    await expect(media.presign({ ...ref, sha: 'x' })).rejects.toThrow('not implemented');
  });
});
