import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNKNOWN_LENGTH_CACHE_BYTES } from '../src/blob.ts';
import worker, { clearRotationLog } from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import { MAX_TRANSFORM_SOURCE_BYTES } from '../src/transform.ts';
import { nowSeconds } from '../src/verify.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  MASTER,
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

/** Size a body without holding a copy of it — the oversized cases are 32 MB. */
async function countBytes(response: Response): Promise<number> {
  const body = response.body;
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

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
  clearRotationLog();
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

  it('never says on /healthz whether a previous signing key is set', async () => {
    const rotating = await worker.fetch(
      new Request(`${ORIGIN}/healthz`),
      fakeEnv({ CONTENT_SIGNING_SECRET_PREVIOUS: 'the-key-being-retired' }),
      fakeContext()
    );
    const settled = await worker.fetch(new Request(`${ORIGIN}/healthz`), fakeEnv(), fakeContext());

    // Byte-identical: /healthz is unauthenticated, and "a rotation is under
    // way here" is not something an anonymous request gets to learn.
    const body = await rotating.text();
    expect(body).toBe(await settled.text());
    expect(JSON.parse(body)).toEqual({ ok: true, environment: 'test', configured: true });
    expect(body.toLowerCase()).not.toContain('previous');
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
        `${ORIGIN}/c/${CLASSROOM}/blob/${BLOB_SHA}.png?p=month&v=1&exp=${futureExp()}&sig=nope`
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
      new Request(`${ORIGIN}${path}?p=month&v=1&exp=${futureExp()}&sig=nope`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('bad-signature');
    expect(message).toContain(`classroom=${CLASSROOM}`);
    expect(message).toContain(`path=${path}`);
    expect(message).toContain('p=month');
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
    expect(message).toContain(`[content] 404 missing classroom=${CLASSROOM}`);
    expect(message).toContain(`path=${ref}`);
    expect(message).not.toContain('cb=1');
  });

  it('cannot be made to forge a second log line through the repo path', async () => {
    // `url.pathname` keeps its escapes, so decoding is what would turn %0A into
    // a real newline - and a newline in console.warn is a whole fake entry, in
    // exactly the shape the README tells operators to search for.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = `logo.png\n[content] 403 bad-signature classroom=${CLASSROOM} path=/c/x`;
    await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent(forged)}`),
      fakeEnv(),
      fakeContext()
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\r');
    // The text survives, defanged - an operator still sees what was asked for.
    expect(message).toContain('logo.png');
    expect(message).toContain('\uFFFD');
  });

  it('caps the logged repo path so one request cannot flood the stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/missing/${'a'.repeat(4000)}`),
      fakeEnv(),
      fakeContext()
    );

    const [message] = warn.mock.calls[0] as [string];
    expect(message.length).toBeLessThan(700);
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

  it('carries Content-Length on an R2 hit, straight from the stored size', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: 'cached-bytes', contentType: 'image/png' },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.headers.get('Content-Length')).toBe(String('cached-bytes'.length));
  });

  it("forwards the origin's Content-Length without buffering to find it", async () => {
    stubUpstreams({
      blob: () => new Response('origin-bytes', { headers: { 'Content-Length': '12' } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const ctx = fakeContext();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.headers.get('Content-Length')).toBe('12');
    // A declared length is the one case R2 can take the stream itself.
    await ctx.settled();
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'text/css; charset=utf-8',
        bytes: 'origin-bytes'.length,
        streamed: true,
      },
    ]);
  });

  it('drops the Content-Length of a compressed origin response', async () => {
    // The runtime adds Accept-Encoding and GitHub gzips text, so the header
    // describes the ENCODED body while `tee()` hands us the decoded bytes.
    // Forwarding it would abort the download with a length mismatch.
    stubUpstreams({
      blob: () =>
        new Response('origin-bytes', {
          headers: { 'Content-Length': '17', 'Content-Encoding': 'gzip' },
        }),
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(response.headers.get('Content-Length')).toBeNull();
    expect(await response.text()).toBe('origin-bytes');
  });

  it('ignores a Content-Length that is not plain digits', async () => {
    // Number('0x10') is 16, and a hex length forwarded as decimal is a mismatch.
    stubUpstreams({
      blob: () => new Response('origin-bytes', { headers: { 'Content-Length': '0x10' } }),
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(response.headers.get('Content-Length')).toBeNull();
  });

  it('omits Content-Length when the origin sent none', async () => {
    stubUpstreams();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(response.headers.get('Content-Length')).toBeNull();
  });

  it('answers HEAD on a cached blob from R2 metadata - no body, no origin', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: 'cached-bytes', contentType: 'image/png' },
    });
    const fetchSpy = vi.fn(() => {
      throw new Error('HEAD must not reach the origin');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });

    const response = await worker.fetch(
      new Request(url, { method: 'HEAD' }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String('cached-bytes'.length));
    expect(response.headers.get('ETag')).toBe(`"blobs/${BLOB_SHA}"`);
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Metadata only: the object's bytes were never opened.
    expect(bucket.heads).toEqual([`blobs/${BLOB_SHA}`]);
    expect(bucket.gets).toEqual([]);
  });

  it('answers HEAD on a cached variant from the variant key', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}/w800.webp`]: { body: 'webp-bytes', contentType: 'image/webp' },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'webp' },
    });

    const response = await worker.fetch(
      new Request(url, { method: 'HEAD' }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(bucket.heads).toEqual([`blobs/${BLOB_SHA}/w800.webp`]);
    expect(bucket.gets).toEqual([]);
  });

  it('falls through to the origin for HEAD on a cold blob, and still sends no body', async () => {
    // Warming the cache on a HEAD is the point: the GET behind it is a hit.
    stubUpstreams();
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(
      new Request(url, { method: 'HEAD' }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(bucket.heads).toEqual([`blobs/${BLOB_SHA}`]);
    await ctx.settled();
    // The whole object, not a stalled prefix: the delivery half of the tee is
    // cancelled rather than abandoned, so the write-back half runs to the end.
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'text/css; charset=utf-8',
        bytes: 'origin-bytes'.length,
        streamed: false,
      },
    ]);
  });

  it('sends no body on a HEAD that is refused', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/robots.txt`, { method: 'HEAD' }),
      fakeEnv(),
      fakeContext()
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  // ── Text blobs ─────────────────────────────────────────────────────────────
  //
  // A deck's index.html, a page's content.json and a theme's css are served by
  // exactly the same path as an image: sha-addressed, signed, immutable. The
  // only thing that changes is the content type — and the guarantee that an
  // .html served from here is INERT if a browser opens it directly.

  it('serves an html blob as inert text/html', async () => {
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: {
        body: '<!doctype html><script>alert(document.cookie)</script>',
        contentType: 'text/html; charset=utf-8',
      },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'html', tier: 'week' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    // The three headers that make the script above harmless. Production serves
    // from content.classmoji.io, inside the app's session-cookie domain, so a
    // top-level navigation to this document must land in an opaque origin.
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
  });

  it('types a text blob from its extension alone, never from its bytes', async () => {
    // The object in R2 has no stored content type at all, and its body is
    // plainly html. The reply is still json, because the SIGNED extension said
    // json — sniffing is what would let one file be re-labelled as another.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: '<!doctype html><p>not json</p>' },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'json', tier: 'week' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('ignores the type R2 stored and trusts the signed extension', async () => {
    // R2 keys are content-addressed — `blobs/{sha}`, no classroom — so ONE
    // object is shared by every classroom and every path holding those bytes,
    // and whichever extension was fetched first wrote the stored type. Trusting
    // it means a stylesheet whose bytes also live at a `.txt` path anywhere in
    // the fleet is served `text/plain` to everyone, and `nosniff` then makes
    // the browser refuse it as a stylesheet. The signed extension is
    // per-request and unforgeable; the stored type is someone else's answer.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: {
        body: 'body { color: red }',
        contentType: 'text/plain; charset=utf-8',
      },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css', tier: 'week' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
  });

  it('answers HEAD from the signed extension too', async () => {
    // Same object, same trap — a HEAD is answered straight from R2 metadata,
    // which is exactly where the wrong stored type lives.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: '<!doctype html>', contentType: 'application/octet-stream' },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'html', tier: 'week' });

    const response = await worker.fetch(
      new Request(url, { method: 'HEAD' }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('serves an `edit` html blob no-store, exactly like an `edit` image', async () => {
    // The per-tier cache lifetimes are decided by `cacheControlFor` on the
    // tier alone; text takes the same answer images take, unchanged.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: { body: '<!doctype html>', contentType: 'text/html; charset=utf-8' },
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'html', tier: 'edit' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('ignores a width on a text blob and serves the original', async () => {
    // `w=` is signed, so it cannot be added by a client — but a stale URL or a
    // caller mistake must not reach the Images binding with a json body. The
    // transform gate is raster-only, and everything else falls through to the
    // plain blob path.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: {
        body: '{"version":1}',
        contentType: 'application/json; charset=utf-8',
      },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'json',
      tier: 'week',
      transform: { w: 800, fmt: 'auto' },
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    // The original key, not `blobs/{sha}/w800.webp` — no variant was consulted.
    expect(bucket.gets).toEqual([`blobs/${BLOB_SHA}`]);
    expect(await response.text()).toBe('{"version":1}');
  });

  it('pulls an html miss from the origin and caches it under the text type', async () => {
    const bucket = fakeBucket();
    const ctx = fakeContext();
    stubUpstreams();

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'html', tier: 'week' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('origin-bytes');
    await ctx.settled();
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'text/html; charset=utf-8',
        bytes: 'origin-bytes'.length,
        streamed: false,
      },
    ]);
  });

  it('marks `edit` content no-store, but still writes it to R2', async () => {
    // Deliberate: `no-store` governs the SHARED caches in front of the Worker,
    // which must never hold `edit` bytes. R2 sits behind the signature gate and
    // is keyed by content hash, so an `edit` blob living there is not a
    // disclosure — and it is what makes publishing a flip rather than a cold
    // fetch. Empty bucket + stubbed origin so a put can actually happen and be
    // observed; seeding the object would have made this assertion vacuous.
    const bucket = fakeBucket();
    const ctx = fakeContext();
    stubUpstreams();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', tier: 'edit' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await ctx.settled();
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'image/png',
        bytes: 'origin-bytes'.length,
        streamed: false,
      },
    ]);
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
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'text/css; charset=utf-8',
        bytes: 'origin-bytes'.length,
        streamed: false,
      },
    ]);
  });

  it('caches a gzipped text blob, whose decoded length the origin never declared', async () => {
    // The production bug. GitHub gzips content.json, index.html and css; the
    // runtime decodes them, so the declared length describes bytes we no longer
    // hold and R2 refuses the resulting unknown-length stream. Every text read
    // was served correctly and then re-pulled from GitHub, forever.
    const bucket = fakeBucket();
    const ctx = fakeContext();
    stubUpstreams({
      blob: () =>
        new Response('{"page":"bytes"}', {
          headers: { 'Content-Length': '19', 'Content-Encoding': 'gzip' },
        }),
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'json' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"page":"bytes"}');
    await ctx.settled();
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'application/json; charset=utf-8',
        bytes: '{"page":"bytes"}'.length,
        streamed: false,
      },
    ]);
  });

  it('hands R2 the stream itself when the origin measured the body', async () => {
    // Images arrive identity-encoded with a real Content-Length, so the length
    // survives to R2 and nothing is ever held in memory.
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const ctx = fakeContext();
    stubUpstreams({
      blob: () => new Response('png-bytes', { headers: { 'Content-Length': '9' } }),
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.settled();
    expect(bucket.puts).toEqual([
      {
        key: `blobs/${BLOB_SHA}`,
        contentType: 'image/png',
        bytes: 'png-bytes'.length,
        streamed: true,
      },
    ]);
  });

  it('serves an unknown-length body over the ceiling without caching it', async () => {
    // Nothing on the real path comes near 32 MB of undeclared length. The
    // ceiling is here so a body that does costs a re-fetch, not the isolate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const chunks = MAX_UNKNOWN_LENGTH_CACHE_BYTES / chunk.byteLength;
    stubUpstreams({
      blob: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < chunks; index += 1) controller.enqueue(chunk);
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          })
        ),
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await countBytes(response)).toBe(MAX_UNKNOWN_LENGTH_CACHE_BYTES + 1);
    await ctx.settled();
    expect(bucket.puts).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toBe(
      `[content] not caching blobs/${BLOB_SHA}: unknown-length origin body over the ` +
        `${MAX_UNKNOWN_LENGTH_CACHE_BYTES} byte ceiling`
    );
  });

  it('logs what R2 actually said when a cache write fails', async () => {
    // Workers Logs renders a thrown object as a bare stack, which is how a
    // put that had been failing on every text blob for weeks read as noise.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bucket = fakeBucket();
    const failing = {
      ...bucket,
      put: async () => {
        throw new Error('the R2 service is having a bad day');
      },
    };
    const ctx = fakeContext();
    stubUpstreams();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'css' });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: failing as unknown as R2Bucket }),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.settled();
    expect(warn.mock.calls[0]?.[0]).toBe(
      `[content] failed to cache blobs/${BLOB_SHA}: the R2 service is having a bad day`
    );
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

  it('skips the transform when R2 already knows the source is too big', async () => {
    // The transform path is the one place a whole object is buffered, inside a
    // shared 128 MB isolate. A known-oversize source never enters it.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}`]: {
        body: 'huge-bytes',
        contentType: 'image/jpeg',
        size: MAX_TRANSFORM_SOURCE_BYTES + 1,
      },
    });
    const images = { input: vi.fn() } as unknown as ImagesBinding;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(await response.text()).toBe('huge-bytes');
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect((images as unknown as { input: ReturnType<typeof vi.fn> }).input).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain(`skipping transform for ${BLOB_SHA}`);
  });

  it("skips the transform when the origin's Content-Length is over the ceiling", async () => {
    stubUpstreams({
      blob: () =>
        new Response('huge-bytes', {
          headers: { 'Content-Length': String(MAX_TRANSFORM_SOURCE_BYTES + 1) },
        }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const images = { input: vi.fn() } as unknown as ImagesBinding;
    const ctx = fakeContext();
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'webp' },
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket, IMAGES: images }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('huge-bytes');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect((images as unknown as { input: ReturnType<typeof vi.fn> }).input).not.toHaveBeenCalled();
    // Streamed, not buffered - the original still lands in R2 on the way past.
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([`blobs/${BLOB_SHA}`]);
  });

  it('aborts a transform whose source outgrows the ceiling mid-stream', async () => {
    // No Content-Length: the only way to hold the bound is to count as we read,
    // and the counted bytes go with the cancelled stream.
    let call = 0;
    stubUpstreams({
      blob: () => {
        call += 1;
        if (call > 1) return new Response('origin-bytes');
        let sent = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent > MAX_TRANSFORM_SOURCE_BYTES) return controller.close();
              sent += 1024 * 1024;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          })
        );
      },
    });
    const bucket = fakeBucket();
    const images = { input: vi.fn() } as unknown as ImagesBinding;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = fakeContext();
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'webp' },
    });

    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket, IMAGES: images }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await response.text()).toBe('origin-bytes');
    expect((images as unknown as { input: ReturnType<typeof vi.fn> }).input).not.toHaveBeenCalled();
    expect(call).toBe(2);
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('skipping transform'))
    ).toBe(true);
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

/**
 * Two keys accepted, one key signed with. The point of the second slot is that
 * URLs already in browsers and caches keep resolving across a key change.
 */
describe('signing key rotation', () => {
  const ROTATED = 'the-rotated-in-master-secret';

  const cachedBlob = () =>
    fakeBucket({ [`blobs/${BLOB_SHA}`]: { body: 'cached-bytes', contentType: 'image/png' } });

  /** Signed under the key being retired — a URL minted before the rotation. */
  const oldUrl = () => signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: MASTER });

  it('serves a previous-key URL while the previous slot is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = fakeEnv({
      CACHE: cachedBlob() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: ROTATED,
      CONTENT_SIGNING_SECRET_PREVIOUS: MASTER,
    });

    const response = await worker.fetch(new Request(await oldUrl()), env, fakeContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('cached-bytes');

    // The one line that tells an operator the old key is still carrying
    // traffic — and, when it stops appearing, that the key can go.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('key=previous');
    expect(message).toContain(`classroom=${CLASSROOM}`);
    expect(message).toContain(`path=/c/${CLASSROOM}/blob/${BLOB_SHA}.png`);
    expect(message).not.toContain('sig=');
  });

  it('logs the rotation once per classroom and key version, not once per request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = fakeEnv({
      CACHE: cachedBlob() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: ROTATED,
      CONTENT_SIGNING_SECRET_PREVIOUS: MASTER,
    });
    const url = await oldUrl();

    for (let i = 0; i < 3; i += 1) {
      const response = await worker.fetch(new Request(url), env, fakeContext());
      expect(response.status).toBe(200);
    }

    // A rotation runs for up to 30 days. One warn per request would bury every
    // 403 and 404 line in the stream for a month.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a whitespace-only previous slot as cleared', async () => {
    // A slot "emptied" with a space must not become a master key the Worker
    // will verify against.
    const env = fakeEnv({
      CACHE: cachedBlob() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: ROTATED,
      CONTENT_SIGNING_SECRET_PREVIOUS: ' ',
    });

    const stale = await worker.fetch(new Request(await oldUrl()), env, fakeContext());
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'bad-signature' });

    // Nor is the blank itself usable as a key by anyone who guesses it.
    const forged = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: ' ' });
    expect((await worker.fetch(new Request(forged), env, fakeContext())).status).toBe(403);

    // The current key still works, so this is a cleared slot and not an outage.
    const current = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: ROTATED });
    expect((await worker.fetch(new Request(current), env, fakeContext())).status).toBe(200);
  });

  it('403s that same URL once the previous slot is cleared', async () => {
    const env = fakeEnv({
      CACHE: cachedBlob() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: ROTATED,
    });
    const response = await worker.fetch(new Request(await oldUrl()), env, fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
  });

  it('says nothing about rotation for a URL the current key signed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = fakeEnv({
      CACHE: cachedBlob() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: ROTATED,
      CONTENT_SIGNING_SECRET_PREVIOUS: MASTER,
    });
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: ROTATED });

    const response = await worker.fetch(new Request(url), env, fakeContext());
    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
