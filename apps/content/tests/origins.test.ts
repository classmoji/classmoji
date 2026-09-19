import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubOrigin } from '../src/origins/github.ts';
import { MediaOrigin } from '../src/origins/media.ts';
import {
  OriginAuthError,
  OriginError,
  deliveryStrategy,
  type OriginAdapter,
} from '../src/origins/types.ts';
import { CLASSROOM, MEDIA_ID, fakeBucket, fakeEnv } from './helpers.ts';

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
  const mediaRef = { classroomId: CLASSROOM, mediaId: MEDIA_ID, variant: 'orig.mp4' };
  const KEY = `m/${CLASSROOM}/${MEDIA_ID}/orig.mp4`;

  it('never redirects', () => {
    // A presigned R2 URL would leave `finalizeHeaders` behind — no CORS, no
    // nosniff, no CSP — and hand the browser a URL we no longer control.
    expect(new MediaOrigin().canPresign).toBe(false);
  });

  it('reads the classroom-scoped key, and reports the stored type', async () => {
    const bucket = fakeBucket({ [KEY]: { body: 'bytes', contentType: 'video/mp4' } });
    const env = fakeEnv({ MEDIA: bucket as unknown as R2Bucket });

    const head = await new MediaOrigin().head(env, mediaRef);
    expect(head?.contentType).toBe('video/mp4');
    expect(head?.object.size).toBe('bytes'.length);
    expect(bucket.heads).toEqual([KEY]);

    const body = await new MediaOrigin().get(env, mediaRef);
    expect(body?.contentType).toBe('video/mp4');
    expect(bucket.gets).toEqual([KEY]);
  });

  it('falls back to the variant when the object has no stored type', async () => {
    const bucket = fakeBucket({
      [`m/${CLASSROOM}/${MEDIA_ID}/poster.webp`]: { body: 'bytes' },
    });
    const env = fakeEnv({ MEDIA: bucket as unknown as R2Bucket });

    const head = await new MediaOrigin().head(env, { ...mediaRef, variant: 'poster.webp' });
    expect(head?.contentType).toBe('image/webp');
  });

  it('passes a range straight to R2', async () => {
    const bucket = fakeBucket({ [KEY]: { body: 'abcdefghij', contentType: 'video/mp4' } });
    const env = fakeEnv({ MEDIA: bucket as unknown as R2Bucket });

    await new MediaOrigin().get(env, mediaRef, { offset: 2, length: 3 });
    expect(bucket.ranges).toEqual([{ key: KEY, range: { offset: 2, length: 3 } }]);
  });

  it('answers null for an object that is not there — there is no origin behind it', async () => {
    const env = fakeEnv({ MEDIA: fakeBucket() as unknown as R2Bucket });
    expect(await new MediaOrigin().head(env, mediaRef)).toBeNull();
    expect(await new MediaOrigin().get(env, mediaRef)).toBeNull();
  });
});
