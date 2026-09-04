import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import { nowSeconds } from '../src/verify.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  MISSING_SHA,
  ORIGIN,
  THEME_BLOB_SHA,
  TREE_SHA,
  fakeBucket,
  fakeContext,
  fakeEnv,
  futureExp,
  signedBlobUrl,
  signedThemeUrl,
} from './helpers.ts';

const realFetch = globalThis.fetch;

/** Routes the two upstreams the Worker talks to: the token endpoint and GitHub. */
function stubUpstreams(handlers: { blob?: () => Response; tree?: () => Response } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/content/token')) {
      return new Response(
        JSON.stringify({
          org: 'classmoji',
          repo: 'content-cs1',
          token: 'ghs_x',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/git/trees/'))
      return handlers.tree?.() ?? new Response(JSON.stringify({ tree: [] }));
    if (url.includes('/git/blobs/')) return handlers.blob?.() ?? new Response('origin-bytes');
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearOriginCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('answers a CORS preflight without touching anything', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/blob/${BLOB_SHA}.png`, { method: 'OPTIONS' }),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('serves /healthz even with no secrets configured', async () => {
    const env = fakeEnv({
      CONTENT_SIGNING_SECRET: undefined,
      CONTENT_WORKER_SHARED_SECRET: undefined,
    });
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), env, fakeContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, environment: 'test', configured: false });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s any path that is not content', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/robots.txt`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('404s a scheme prefix that is not /c/ — there is only one content prefix', async () => {
    const url = (await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' })).replace('/c/', '/c2/');
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(404);
  });

  it('405s a write attempt', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/blob/${BLOB_SHA}.png`, { method: 'POST' }),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(405);
  });

  it('fails closed with 503 when a secret is missing', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CONTENT_WORKER_SHARED_SECRET: undefined }),
      fakeContext()
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not configured' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('403s an unsigned or tampered URL, and never caches the refusal', async () => {
    const response = await worker.fetch(
      new Request(
        `${ORIGIN}/c/${CLASSROOM}/blob/${BLOB_SHA}.png?p=public&v=1&exp=${futureExp()}&sig=nope`
      ),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('logs the reason, classroom, path, and p/v on a 403 - never the signature', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = `/c/${CLASSROOM}/blob/${BLOB_SHA}.png`;
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}?p=public&v=1&exp=${futureExp()}&sig=nope`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('bad-signature');
    expect(message).toContain(`classroom=${CLASSROOM}`);
    expect(message).toContain(`path=${path}`);
    expect(message).toContain('p=public');
    expect(message).toContain('v=1');
    expect(message).not.toContain('sig=');
  });

  it('403s a URL minted for a different delivery host', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', signedHost: 'evil.example.com' });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
  });

  it('403s a blob URL carrying an unexpected query param', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(new Request(`${url}&cb=1`), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });

  it("404s the resolver's dangling-reference URL rather than 403ing it", async () => {
    // The app mints /c/{classroomId}/missing/{encodedRepoPath} for a reference
    // it cannot resolve. A deleted file is not a tampered URL.
    const ref = 'assets/img/logo v2.png';
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent(ref)}`),
      fakeEnv(),
      fakeContext()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'missing' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  it('logs the classroom and the decoded repo path on a 404 missing - never the query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref = 'assets/img/logo.png';
    await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent(ref)}?cb=1`),
      fakeEnv(),
      fakeContext()
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toBe(`[content] 404 missing classroom=${CLASSROOM} path=${ref}`);
    expect(message).not.toContain('cb=1');
  });

  it('403s any other unknown segment - only /missing/ is a known unsigned shape', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/other/x`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });

  it('403s a /missing/ URL whose classroom is not a uuid', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/not-a-uuid/missing/logo.png`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
  });

  it('403s an expired URL with the reason', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', exp: nowSeconds() - 86400 });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'expired' });
  });
});

describe('blob delivery', () => {
  it('serves a cached blob straight from R2', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: 'cached-bytes', contentType: 'image/png' },
    });
    const env = fakeEnv({ CACHE: bucket as unknown as R2Bucket });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });

    const response = await worker.fetch(new Request(url), env, fakeContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('cached-bytes');
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
    // Without Vary, the first visitor's negotiated format is pinned for everyone.
    expect(response.headers.get('Vary')).toBe('Accept');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(bucket.gets).toEqual([`blobs/${BLOB_SHA}`]);
  });

  it('marks draft content no-store, but still writes it to R2', async () => {
    // Deliberate: `no-store` governs the SHARED caches in front of the Worker,
    // which must never hold draft bytes. R2 sits behind the signature gate and
    // is keyed by content hash, so a draft blob living there is not a
    // disclosure — and it is what makes publishing a flip rather than a cold
    // fetch. Empty bucket + stubbed origin so a put can actually happen and be
    // observed; seeding the object would have made this assertion vacuous.
    const bucket = fakeBucket();
    const ctx = fakeContext();
    stubUpstreams();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', tier: 'draft' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await ctx.settled();
    expect(bucket.puts).toEqual([{ key: `blobs/${BLOB_SHA}`, contentType: 'image/png' }]);
  });

  it('pulls a miss from the origin and writes it back to R2', async () => {
    const bucket = fakeBucket();
    const env = fakeEnv({ CACHE: bucket as unknown as R2Bucket });
    const ctx = fakeContext();
    stubUpstreams();

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });
    const response = await worker.fetch(new Request(url), env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(await response.text()).toBe('origin-bytes');
    await ctx.settled();
    expect(bucket.puts).toEqual([
      { key: `blobs/${BLOB_SHA}`, contentType: 'text/css; charset=utf-8' },
    ]);
  });

  it('502s an origin failure and does not cache it', async () => {
    stubUpstreams({ blob: () => new Response('nope', { status: 404 }) });
    const bucket = fakeBucket();
    const ctx = fakeContext();

    const url = await signedBlobUrl({ sha: MISSING_SHA, ext: 'png' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await ctx.settled();
    expect(bucket.puts).toEqual([]);
  });

  it('reads the avif variant when the browser accepts avif and fmt=auto', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}/w800.avif`]: { body: 'avif-bytes', contentType: 'image/avif' },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'auto' },
    });

    const response = await worker.fetch(
      new Request(url, { headers: { Accept: 'image/avif,image/webp,*/*' } }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('avif-bytes');
    expect(bucket.gets).toEqual([`blobs/${BLOB_SHA}/w800.avif`]);
  });

  it('reads the webp variant for a browser that cannot decode avif', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}/w1600.webp`]: { body: 'webp-bytes', contentType: 'image/webp' },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 1600, fmt: 'auto' },
    });

    await worker.fetch(
      new Request(url, { headers: { Accept: 'image/webp,*/*' } }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(bucket.gets).toEqual([`blobs/${BLOB_SHA}/w1600.webp`]);
  });

  it('ignores a transform on a format Images cannot decode', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: '<svg/>', contentType: 'image/svg+xml' },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'svg',
      transform: { w: 800, fmt: 'auto' },
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(bucket.gets).toEqual([`blobs/${BLOB_SHA}`]);
  });

  it('serves the original bytes when the Images binding throws', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: 'original-bytes', contentType: 'image/jpeg' },
    });
    const images = {
      input() {
        throw new Error('unsupported source');
      },
    } as unknown as ImagesBinding;
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'webp' },
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket, IMAGES: images }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('original-bytes');
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    // A quota blip must not pin the un-resized original at the edge for a month.
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });
});

describe('theme delivery', () => {
  const tree = JSON.stringify([{ path: 'css/site.css', sha: THEME_BLOB_SHA, type: 'blob' }]);

  it('resolves a theme path through the cached tree listing', async () => {
    const bucket = fakeBucket({
      [`trees/${TREE_SHA}.json`]: { body: tree, contentType: 'application/json; charset=utf-8' },
      [`blobs/${THEME_BLOB_SHA}`]: { body: 'body{}', contentType: 'text/css; charset=utf-8' },
    });
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('body{}');
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(bucket.gets).toEqual([`trees/${TREE_SHA}.json`, `blobs/${THEME_BLOB_SHA}`]);
  });

  it('fetches and stores the tree listing on a miss', async () => {
    stubUpstreams({
      tree: () =>
        new Response(
          JSON.stringify({ tree: [{ path: 'css/site.css', sha: THEME_BLOB_SHA, type: 'blob' }] })
        ),
    });
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([
      `trees/${TREE_SHA}.json`,
      `blobs/${THEME_BLOB_SHA}`,
    ]);
  });

  it('serves a truncated listing but never stores it', async () => {
    // The key is content-addressed and treated as immutable, so caching a
    // partial listing would 404 every omitted file forever — for every
    // classroom that shares this tree sha.
    stubUpstreams({
      tree: () =>
        new Response(
          JSON.stringify({
            truncated: true,
            tree: [{ path: 'css/site.css', sha: THEME_BLOB_SHA, type: 'blob' }],
          })
        ),
    });
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([`blobs/${THEME_BLOB_SHA}`]);
  });

  it('404s a path that is not in the tree', async () => {
    const bucket = fakeBucket({ [`trees/${TREE_SHA}.json`]: { body: tree } });
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/missing.css',
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });
});
