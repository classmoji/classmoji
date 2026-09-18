/**
 * Save-to-disk delivery: a blob URL whose signature carries a display filename.
 *
 * The bytes are unchanged — same R2 key, same origin pull, same ranges. Only
 * three headers differ, and only on these responses: `Content-Disposition`
 * built per request from the signed name, a CSP that permits the download it is
 * asking for, and `no-store`. The filename NEVER reaches R2: `blobs/{sha}` is
 * shared by every classroom that references those bytes, and a name belongs to
 * one slide row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { clearRotationLog } from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  fakeBucket,
  fakeContext,
  fakeEnv,
  signedBlobUrl,
  stubUpstreams,
} from './helpers.ts';

const realFetch = globalThis.fetch;

const KEY = `blobs/${BLOB_SHA}`;
const FILENAME = 'Week 3 — Recursion.pdf';
/** Both forms, as RFC 6266 wants them: the quoted fallback, then RFC 8187. */
const DISPOSITION =
  `attachment; filename="Week 3 _ Recursion.pdf"; ` +
  `filename*=UTF-8''Week%203%20%E2%80%94%20Recursion.pdf`;

const STRICT_CSP = "default-src 'none'; sandbox";
const DOWNLOAD_CSP = "default-src 'none'; sandbox allow-downloads";

function cachedFile(contentType = 'application/pdf') {
  return fakeBucket({ [KEY]: { body: 'slide-deck-bytes', contentType } });
}

async function fetchBlob(
  bucket: ReturnType<typeof fakeBucket>,
  options: Parameters<typeof signedBlobUrl>[0],
  init: RequestInit = {}
) {
  const url = await signedBlobUrl(options);
  const ctx = fakeContext();
  const response = await worker.fetch(
    new Request(url, init),
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
  vi.restoreAllMocks();
});

describe('download delivery', () => {
  it('serves a cached file as an attachment', async () => {
    const bucket = cachedFile();
    const { response } = await fetchBlob(bucket, {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('slide-deck-bytes');
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    expect(response.headers.get('Content-Security-Policy')).toBe(DOWNLOAD_CSP);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // The type still comes from the SIGNED extension, and everything a normal
    // blob reply carries is still there.
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Length')).toBe(String('slide-deck-bytes'.length));
    expect(response.headers.get('ETag')).toBe(`"${KEY}"`);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('answers HEAD from R2 metadata, still as an attachment', async () => {
    const bucket = cachedFile();
    const fetchSpy = vi.fn(() => {
      throw new Error('HEAD must not reach the origin');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { response } = await fetchBlob(
      bucket,
      { sha: BLOB_SHA, ext: 'pdf', tier: 'download', dl: FILENAME },
      { method: 'HEAD' }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    expect(response.headers.get('Content-Security-Policy')).toBe(DOWNLOAD_CSP);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bucket.heads).toEqual([KEY]);
    expect(bucket.gets).toEqual([]);
  });

  it('keeps the disposition on a 206 served out of R2', async () => {
    // A resumed download is the realistic case: the second leg is a range, and
    // a browser that loses the filename halfway saves the sha instead.
    const bucket = cachedFile();
    const { response } = await fetchBlob(
      bucket,
      { sha: BLOB_SHA, ext: 'pdf', tier: 'download', dl: FILENAME },
      { headers: { Range: 'bytes=0-4' } }
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('slide');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-4/16');
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    expect(response.headers.get('Content-Security-Policy')).toBe(DOWNLOAD_CSP);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps the disposition on a cold origin pull, and caches the bytes alone', async () => {
    stubUpstreams({ blob: () => new Response('origin-pdf-bytes') });
    const bucket = fakeBucket();
    const { response, ctx } = await fetchBlob(bucket, {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    expect(await response.text()).toBe('origin-pdf-bytes');

    await ctx.settled();
    // The cache write is keyed by sha and carries the type and nothing else:
    // a filename stored here would be handed to the next classroom that
    // references the same bytes.
    expect(bucket.puts).toEqual([
      {
        key: KEY,
        contentType: 'application/pdf',
        bytes: 'origin-pdf-bytes'.length,
        streamed: false,
      },
    ]);
    expect(JSON.stringify(bucket.puts)).not.toContain('Recursion');
  });

  it('keeps the disposition on a range resolved against the origin', async () => {
    stubUpstreams({
      blob: () => new Response('origin-pdf-bytes', { headers: { 'Content-Length': '16' } }),
    });
    const bucket = fakeBucket({}, { originDeclaresLength: true });
    const { response, ctx } = await fetchBlob(
      bucket,
      { sha: BLOB_SHA, ext: 'pdf', tier: 'download', dl: FILENAME },
      { headers: { Range: 'bytes=0-5' } }
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('origin');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-5/16');
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    expect(response.headers.get('Content-Security-Policy')).toBe(DOWNLOAD_CSP);

    // The cache write still runs: the whole point of tee'ing a ranged miss.
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([KEY]);
  });

  it('serves an unmapped type as an opaque attachment rather than inventing one', async () => {
    // `pptx` is deliberately NOT in the MIME map: octet-stream plus a
    // `Content-Disposition` is exactly what a save-to-disk reply should be.
    const bucket = cachedFile('application/octet-stream');
    const { response } = await fetchBlob(bucket, {
      sha: BLOB_SHA,
      ext: 'pptx',
      tier: 'download',
      dl: 'lecture.pptx',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="lecture.pptx"; filename*=UTF-8''lecture.pptx`
    );
  });

  it('changes nothing but those three headers', async () => {
    // The compatibility claim, asserted rather than argued: same blob, same
    // fixture, with and without a `dl`.
    const asDownload = await fetchBlob(cachedFile(), {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
    });
    const plain = await fetchBlob(cachedFile(), { sha: BLOB_SHA, ext: 'pdf', tier: 'month' });

    const changed = ['content-disposition', 'content-security-policy', 'cache-control'];
    const rest = (response: Response) =>
      [...response.headers.entries()]
        .filter(([name]) => !changed.includes(name))
        .sort(([a], [b]) => a.localeCompare(b));

    expect(rest(asDownload.response)).toEqual(rest(plain.response));
    expect(plain.response.headers.get('Content-Disposition')).toBeNull();
    expect(plain.response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
    expect(plain.response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
  });

  it('403s a swapped, added, or stripped filename', async () => {
    const bucket = cachedFile();
    const env = fakeEnv({ CACHE: bucket as unknown as R2Bucket });
    const signed = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: 'deck.pdf',
    });
    const other = new URL(
      await signedBlobUrl({ sha: BLOB_SHA, ext: 'pdf', tier: 'download', dl: 'exam-answers.pdf' })
    ).searchParams.get('dl') as string;

    const swapped = new URL(signed);
    swapped.searchParams.set('dl', other);
    const stripped = new URL(signed);
    stripped.searchParams.delete('dl');
    const plain = await signedBlobUrl({ sha: BLOB_SHA, ext: 'pdf', tier: 'month' });

    for (const url of [swapped.toString(), stripped.toString(), `${plain}&dl=${other}`]) {
      const response = await worker.fetch(new Request(url), env, fakeContext());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'bad-signature' });
      expect(response.headers.get('Content-Disposition')).toBeNull();
    }
    // Nothing was served, so nothing was read.
    expect(bucket.gets).toEqual([]);
  });

  it('403s an unbounded or empty dl as malformed', async () => {
    const signed = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: 'deck.pdf',
    });
    for (const value of ['a'.repeat(5000), '']) {
      const url = new URL(signed);
      url.searchParams.set('dl', value);
      const response = await worker.fetch(new Request(url.toString()), fakeEnv(), fakeContext());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'malformed' });
    }
  });

  it('403s a repeated dl, which `get` would only half-see', async () => {
    const signed = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: 'deck.pdf',
    });
    const response = await worker.fetch(
      new Request(`${signed}&dl=ZXZpbC5leGU`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });

  it('never turns a refusal into a download', async () => {
    // An error body is JSON, and telling the browser to SAVE a 502 as
    // `Week 3 — Recursion.pdf` would be worse than the failure itself.
    stubUpstreams({ blob: () => new Response('nope', { status: 404 }) });
    const { response } = await fetchBlob(fakeBucket(), {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('leaves a 416 alone as well', async () => {
    const { response } = await fetchBlob(
      cachedFile(),
      { sha: BLOB_SHA, ext: 'pdf', tier: 'download', dl: FILENAME },
      { headers: { Range: 'bytes=9999-10000' } }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */16');
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
  });

  it('applies to an image variant too, since the rule is the filename', async () => {
    const bucket = fakeBucket({
      [`${KEY}/w800.webp`]: { body: 'webp-bytes', contentType: 'image/webp' },
    });
    const { response } = await fetchBlob(bucket, {
      sha: BLOB_SHA,
      ext: 'jpg',
      tier: 'download',
      transform: { w: 800, fmt: 'webp' },
      dl: 'poster.jpg',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="poster.jpg"; filename*=UTF-8''poster.jpg`
    );
  });

  it('is honoured on any tier — the filename decides, not the window', async () => {
    // The signer refuses to MINT this (a save-to-disk link has no business
    // being immutable for a week), so the fixture hand-signs it. The Worker's
    // side of that split is what this pins: a valid signature is served, and
    // the filename is what turns the reply into an attachment.
    const { response } = await fetchBlob(cachedFile(), {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'week',
      dl: FILENAME,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    // A week-tier URL would otherwise be immutable for seven days; a per-viewer
    // filename on shared bytes is the reason it must not be stored.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('logs no filename on a refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signed = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
    });
    const url = new URL(signed);
    url.searchParams.set('sig', 'nope');

    const response = await worker.fetch(new Request(url.toString()), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(`classroom=${CLASSROOM}`);
    expect(message).toContain(`path=/c/${CLASSROOM}/blob/${BLOB_SHA}.pdf`);
    // The 403 line carries no query string at all, so no `dl` either.
    expect(message).not.toContain('dl=');
    expect(message).not.toContain('sig=');
  });

  it('is still bound to the delivery host it was minted for', async () => {
    const bucket = cachedFile();
    const { response } = await fetchBlob(bucket, {
      sha: BLOB_SHA,
      ext: 'pdf',
      tier: 'download',
      dl: FILENAME,
      signedHost: 'evil.example.com',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
    expect(bucket.gets).toEqual([]);
  });
});
