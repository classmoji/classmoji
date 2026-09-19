/**
 * Byte ranges, from the parser up to the delivered response.
 *
 * The bug this suite exists for: a `.webm` served out of R2 answered
 * `Range: bytes=0-1023` with a `200` and the whole 1.35 MB body, and sent no
 * `Accept-Ranges` at all. Chrome's `<video>` element reads that as "cannot
 * seek", stays at `readyState 0`, reports no duration and never plays. Safari
 * tolerates it, which is why it survived review.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { clearRotationLog } from '../src/index.ts';
import { parseRange, sliceStream } from '../src/range.ts';
import { clearOriginCache } from '../src/token.ts';
import {
  BLOB_SHA,
  fakeBucket,
  fakeContext,
  fakeEnv,
  signedBlobUrl,
  stubUpstreams,
} from './helpers.ts';

const realFetch = globalThis.fetch;

/**
 * 4 KiB standing in for a video: printable ASCII, so one byte is one character
 * and a served range can be compared against a plain string slice.
 */
const MEDIA = Array.from({ length: 4096 }, (_, index) =>
  String.fromCharCode(33 + (index % 90))
).join('');

const KEY = `blobs/${BLOB_SHA}`;
const ETAG = `"${KEY}"`;

function cachedMedia() {
  return fakeBucket({ [KEY]: { body: MEDIA, contentType: 'video/webm' } });
}

async function fetchMedia(
  bucket: ReturnType<typeof fakeBucket>,
  headers: Record<string, string>,
  init: RequestInit = {}
) {
  const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'webm' });
  const ctx = fakeContext();
  const response = await worker.fetch(
    new Request(url, { ...init, headers }),
    fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
    ctx
  );
  return { response, ctx };
}

beforeEach(() => {
  clearOriginCache();
  clearRotationLog();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('parseRange', () => {
  it('resolves a closed range', () => {
    expect(parseRange('bytes=0-1023', 4096)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 1023 },
    });
  });

  it('resolves an open-ended range to the last byte', () => {
    expect(parseRange('bytes=1000-', 4096)).toEqual({
      kind: 'partial',
      range: { start: 1000, end: 4095 },
    });
  });

  it('resolves a suffix range from the end', () => {
    expect(parseRange('bytes=-500', 4096)).toEqual({
      kind: 'partial',
      range: { start: 3596, end: 4095 },
    });
  });

  it('clamps a suffix longer than the object to the whole object', () => {
    expect(parseRange('bytes=-9999', 4096)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 4095 },
    });
  });

  it('clamps a last position past the end rather than refusing it', () => {
    // "up to here" where here is past the end is a request for the rest.
    expect(parseRange('bytes=4000-99999', 4096)).toEqual({
      kind: 'partial',
      range: { start: 4000, end: 4095 },
    });
  });

  it('calls a first position at or past the end unsatisfiable', () => {
    expect(parseRange('bytes=4096-', 4096)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=9999-10000', 4096)).toEqual({ kind: 'unsatisfiable' });
  });

  it('calls a zero-length suffix unsatisfiable', () => {
    expect(parseRange('bytes=-0', 4096)).toEqual({ kind: 'unsatisfiable' });
  });

  it('calls any range against an empty object unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a multi-range request rather than refusing it', () => {
    // Legal to ask for, legal to answer whole. Nothing in the fleet asks.
    expect(parseRange('bytes=0-99,200-299', 4096)).toEqual({ kind: 'full' });
  });

  it('ignores a malformed spec instead of turning it into a 416', () => {
    // Garbage is not a claim about the object, so it is not an error about one.
    for (const header of ['bytes=abc-def', 'items=0-10', 'bytes=', 'bytes=-', 'bytes=10-5', '']) {
      expect(parseRange(header, 4096)).toEqual({ kind: 'full' });
    }
  });

  it('accepts the whitespace and casing RFC 7230 allows', () => {
    expect(parseRange('  Bytes = 0-9  ', 4096)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 9 },
    });
  });

  it('treats an absent header as a request for everything', () => {
    expect(parseRange(null, 4096)).toEqual({ kind: 'full' });
  });
});

describe('sliceStream', () => {
  it('emits only the requested bytes across chunk boundaries', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of ['abcde', 'fghij', 'klmno']) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    expect(await new Response(sliceStream(source, 3, 11)).text()).toBe('defghijkl');
  });
});

describe('byte ranges out of the cache', () => {
  it('answers a closed range with 206 and exactly those bytes', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=0-1023' });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(MEDIA.slice(0, 1024));
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
    expect(response.headers.get('Content-Length')).toBe('1024');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Type')).toBe('video/webm');
    expect(response.headers.get('ETag')).toBe(ETAG);
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // R2 read 1 KiB, not 4 KiB and then a slice — that is what makes a seek
    // into a large video cheap.
    expect(bucket.ranges).toEqual([{ key: KEY, range: { offset: 0, length: 1024 } }]);
  });

  it('serves an open-ended range to the last byte', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=1000-' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 1000-4095/4096');
    expect(response.headers.get('Content-Length')).toBe('3096');
    expect(await response.text()).toBe(MEDIA.slice(1000));
    expect(bucket.ranges).toEqual([{ key: KEY, range: { offset: 1000, length: 3096 } }]);
  });

  it('serves a suffix range from the end', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=-500' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3596-4095/4096');
    expect(response.headers.get('Content-Length')).toBe('500');
    expect(await response.text()).toBe(MEDIA.slice(3596));
    // Resolved to concrete positions before R2 sees it, so the total in
    // `Content-Range` and the bytes served cannot disagree.
    expect(bucket.ranges).toEqual([{ key: KEY, range: { offset: 3596, length: 500 } }]);
  });

  it('416s a range past the end, and says how big the object really is', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=8192-9000' });

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */4096');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.json()).toEqual({ error: 'range not satisfiable' });
    // Decided from metadata: not one byte was read to refuse it.
    expect(bucket.heads).toEqual([KEY]);
    expect(bucket.gets).toEqual([]);
  });

  it('answers a multi-range request with the whole object', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=0-99,200-299' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('4096');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe(MEDIA);
    expect(bucket.ranges).toEqual([]);
  });

  it('advertises Accept-Ranges on a full 200 with no Range at all', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, {});

    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    // No `Range` means the one-call path: a `head` would be a wasted round trip.
    expect(bucket.heads).toEqual([]);
    expect(bucket.gets).toEqual([KEY]);
  });
});

describe('byte ranges on HEAD', () => {
  it('advertises Accept-Ranges and keeps Content-Length', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, {}, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe('4096');
    expect(bucket.gets).toEqual([]);
  });

  it('answers a ranged HEAD with 206 headers and no bytes read', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=0-1023' }, { method: 'HEAD' });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
    expect(response.headers.get('Content-Length')).toBe('1024');
    expect(bucket.heads).toEqual([KEY]);
    expect(bucket.gets).toEqual([]);
  });
});

describe('If-Range', () => {
  it('serves the range when the validator still matches', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, { Range: 'bytes=0-9', 'If-Range': ETAG });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(MEDIA.slice(0, 10));
  });

  it('serves the whole object when the validator has moved on', async () => {
    const bucket = cachedMedia();
    const { response } = await fetchMedia(bucket, {
      Range: 'bytes=0-9',
      'If-Range': '"some-older-version"',
    });

    // A failed `If-Range` is a 200, never an error: the client asked for a
    // slice of a file it turns out not to have.
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(await response.text()).toBe(MEDIA);
  });
});

describe('byte ranges on a cache miss', () => {
  it('serves 206 from the pull and still lands the whole object in R2', async () => {
    stubUpstreams({
      blob: () => new Response(MEDIA, { headers: { 'Content-Length': String(MEDIA.length) } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response, ctx } = await fetchMedia(bucket, { Range: 'bytes=0-1023' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
    expect(response.headers.get('Content-Length')).toBe('1024');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe(MEDIA.slice(0, 1024));

    // The client took 1 KiB; the cache branch still ran to the end, so the next
    // request for this video is an R2 hit rather than a second GitHub pull.
    await ctx.settled();
    expect(bucket.puts).toEqual([
      { key: KEY, contentType: 'video/webm', bytes: 4096, streamed: true },
    ]);
  });

  it('serves a mid-object range from a pull without buffering the object', async () => {
    stubUpstreams({
      blob: () => new Response(MEDIA, { headers: { 'Content-Length': String(MEDIA.length) } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response, ctx } = await fetchMedia(bucket, { Range: 'bytes=2000-2099' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2000-2099/4096');
    expect(await response.text()).toBe(MEDIA.slice(2000, 2100));
    await ctx.settled();
    expect(bucket.puts.map(put => put.bytes)).toEqual([4096]);
  });

  it('416s an unsatisfiable range on a miss, and still caches the pull', async () => {
    stubUpstreams({
      blob: () => new Response(MEDIA, { headers: { 'Content-Length': String(MEDIA.length) } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response, ctx } = await fetchMedia(bucket, { Range: 'bytes=9000-' });

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */4096');
    // The pull is already paid for; only the client's half of the tee was
    // cancelled, so the corrected retry is a hit.
    await ctx.settled();
    expect(bucket.puts.map(put => put.bytes)).toEqual([4096]);
  });

  it('buffers to resolve a range when the origin declared no length', async () => {
    // GitHub gzips text and the runtime decodes it, so the length is gone. A
    // total has to be counted before `Content-Range` can name one.
    stubUpstreams({ blob: () => new Response(MEDIA) });
    const bucket = fakeBucket();
    const { response, ctx } = await fetchMedia(bucket, { Range: 'bytes=-100' });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3996-4095/4096');
    expect(await response.text()).toBe(MEDIA.slice(3996));
    await ctx.settled();
    expect(bucket.puts).toEqual([
      { key: KEY, contentType: 'video/webm', bytes: 4096, streamed: false },
    ]);
  });

  it('falls back to a full 200 for a multi-range miss', async () => {
    stubUpstreams({
      blob: () => new Response(MEDIA, { headers: { 'Content-Length': String(MEDIA.length) } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response, ctx } = await fetchMedia(bucket, { Range: 'bytes=0-9,20-29' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MEDIA);
    await ctx.settled();
    expect(bucket.puts.map(put => put.bytes)).toEqual([4096]);
  });

  it('ignores an If-Range on a miss, because there is no validator to check', async () => {
    stubUpstreams({
      blob: () => new Response(MEDIA, { headers: { 'Content-Length': String(MEDIA.length) } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response } = await fetchMedia(bucket, {
      Range: 'bytes=0-9',
      'If-Range': '"anything"',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MEDIA);
  });
});

describe('byte ranges and image variants', () => {
  it('answers a Range on a ?w= URL with the full variant', async () => {
    // Variants are raster stills; the clients that seek are media players, and
    // none of them fetch a resized image. RFC 7233 §3.1 permits ignoring it.
    const bucket = fakeBucket({
      [`blobs/${BLOB_SHA}/w800.webp`]: { body: 'webp-bytes', contentType: 'image/webp' },
    });
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 800, fmt: 'webp' },
    });

    const response = await worker.fetch(
      new Request(url, { headers: { Range: 'bytes=0-3' } }),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Range')).toBeNull();
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(await response.text()).toBe('webp-bytes');
    expect(bucket.ranges).toEqual([]);
  });
});
