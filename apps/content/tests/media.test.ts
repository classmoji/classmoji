/**
 * Media delivery: `/c/{classroomId}/media/{mediaId}/{variant}`.
 *
 * The same answers a blob gives — 200, 206, 416, HEAD from metadata, the
 * tier's cache-control, CORS, nosniff, the sandboxing CSP, an attachment when
 * the signature carried a filename — out of a bucket that has no origin behind
 * it. Two things are proved here that the blob suites cannot: that a miss is a
 * 404 rather than a pull, and that this path never writes anything anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { clearRotationLog } from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import { nowSeconds } from '../src/verify.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  MEDIA_ID,
  MISSING_MEDIA_ID,
  ORIGIN,
  fakeBucket,
  fakeContext,
  fakeEnv,
  signedBlobUrl,
  signedMediaUrl,
} from './helpers.ts';

const realFetch = globalThis.fetch;

/** A classroom that is not the one the fixtures sign for. */
const OTHER_CLASSROOM = 'c1a55c0d-0000-4000-8000-000000000002';

const STRICT_CSP = "default-src 'none'; sandbox";
const DOWNLOAD_CSP = "default-src 'none'; sandbox allow-downloads";

/**
 * 4 KiB standing in for a video: printable ASCII, so one byte is one character
 * and a served range can be compared against a plain string slice.
 */
const VIDEO = Array.from({ length: 4096 }, (_, index) =>
  String.fromCharCode(33 + (index % 90))
).join('');

const key = (variant: string, classroomId = CLASSROOM, mediaId = MEDIA_ID) =>
  `m/${classroomId}/${mediaId}/${variant}`;

function mediaBucket(
  variant = 'orig.mp4',
  body = VIDEO,
  contentType: string | undefined = 'video/mp4'
) {
  return fakeBucket({ [key(variant)]: { body, contentType } });
}

async function fetchMedia(
  media: ReturnType<typeof fakeBucket>,
  options: Parameters<typeof signedMediaUrl>[0],
  init: RequestInit = {},
  envOverrides: Record<string, unknown> = {}
) {
  const cache = fakeBucket();
  const url = await signedMediaUrl(options);
  const response = await worker.fetch(
    new Request(url, init),
    fakeEnv({
      MEDIA: media as unknown as R2Bucket,
      CACHE: cache as unknown as R2Bucket,
      ...envOverrides,
    }),
    fakeContext()
  );
  return { response, cache };
}

beforeEach(() => {
  clearOriginCache();
  clearRotationLog();
  // No upstream is stubbed on purpose: a media request that reached for the
  // token endpoint or GitHub would throw here, which is the assertion.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`media delivery must not fetch: ${String(input)}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('media delivery', () => {
  it('serves a media object straight from the media bucket', async () => {
    const media = mediaBucket();
    const { response, cache } = await fetchMedia(media, { variant: 'orig.mp4' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(VIDEO);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Length')).toBe(String(VIDEO.length));
    expect(response.headers.get('ETag')).toBe(`"${key('orig.mp4')}"`);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
    expect(media.gets).toEqual([key('orig.mp4')]);
    // The MEDIA bucket is the store, so there is nothing to warm: the content
    // cache is not read, not written, not even looked at.
    expect(cache.gets).toEqual([]);
    expect(cache.heads).toEqual([]);
    expect(cache.puts).toEqual([]);
  });

  it('never writes to the media bucket', async () => {
    // This Worker only reads media. Everything in that bucket was put there by
    // the app over the S3 API, and a write from here would be a second writer
    // nobody accounts for.
    const media = mediaBucket();
    await fetchMedia(media, { variant: 'orig.mp4' });
    await fetchMedia(media, { variant: 'orig.mp4' }, { headers: { Range: 'bytes=0-99' } });
    await fetchMedia(media, { variant: 'orig.mp4' }, { method: 'HEAD' });

    expect(media.puts).toEqual([]);
  });

  it('serves the type the upload recorded, not the one the bytes suggest', async () => {
    // The stored type was assigned by `createUpload` from an allowlist. The
    // bytes are never sniffed, and `nosniff` is what makes that stick.
    const media = mediaBucket('orig.mp4', '<!doctype html><script>alert(1)</script>', 'video/mp4');
    const { response } = await fetchMedia(media, { variant: 'orig.mp4' });

    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
  });

  it.each([
    ['web.mp4', 'video/mp4'],
    ['poster.webp', 'image/webp'],
    ['orig.pdf', 'application/pdf'],
    // The three the general web table does not know: an `orig.{ext}` falls back
    // to the MEDIA store's own table, the same one the upload assigned from.
    ['orig.mov', 'video/quicktime'],
    ['orig.mp3', 'audio/mpeg'],
    ['orig.zip', 'application/zip'],
    ['orig.xyz', 'application/octet-stream'],
  ])('falls back to the %s variant for the content type', async (variant, expected) => {
    // An object stored without an httpMetadata type — the variant names what it
    // is, and an extension neither table knows is an opaque download.
    const media = fakeBucket({ [key(variant)]: { body: VIDEO, contentType: undefined } });
    const { response } = await fetchMedia(media, { variant });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(expected);
  });

  it('answers HEAD from metadata alone', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(media, { variant: 'orig.mp4' }, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Length')).toBe(String(VIDEO.length));
    expect(response.headers.get('ETag')).toBe(`"${key('orig.mp4')}"`);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(media.heads).toEqual([key('orig.mp4')]);
    expect(media.gets).toEqual([]);
  });

  it('404s an object that is not in the bucket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(mediaBucket(), {
      mediaId: MISSING_MEDIA_ID,
      variant: 'orig.mp4',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // Never 502: there is no origin behind this bucket to be unavailable.
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(`404 media classroom=${CLASSROOM}`);
    expect(message).toContain(`media=${MISSING_MEDIA_ID}`);
    expect(message).not.toContain('sig=');
  });

  it('404s a HEAD for an object that is not there, with no body', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(
      mediaBucket(),
      { mediaId: MISSING_MEDIA_ID, variant: 'orig.mp4' },
      { method: 'HEAD' }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('reads a different classroom prefix for a URL signed by a different classroom', async () => {
    // The signature is valid — it is simply not for this classroom's object,
    // and the key it addresses is under that classroom's prefix. Nothing there,
    // so nothing served: a media key can never reach across classrooms.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const media = mediaBucket();
    const { response } = await fetchMedia(media, {
      classroomId: OTHER_CLASSROOM,
      variant: 'orig.mp4',
    });

    expect(response.status).toBe(404);
    expect(media.heads).toEqual([]);
    expect(media.gets).toEqual([key('orig.mp4', OTHER_CLASSROOM)]);
  });
});

describe('media ranges', () => {
  it('answers a closed range with a 206 and R2 reads only those bytes', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { headers: { Range: 'bytes=0-1023' } }
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(VIDEO.slice(0, 1024));
    expect(response.headers.get('Content-Range')).toBe(`bytes 0-1023/${VIDEO.length}`);
    expect(response.headers.get('Content-Length')).toBe('1024');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('ETag')).toBe(`"${key('orig.mp4')}"`);
    // The whole point: a seek into the middle of a lecture costs one ranged
    // read, not the whole object.
    expect(media.ranges).toEqual([{ key: key('orig.mp4'), range: { offset: 0, length: 1024 } }]);
  });

  it('resolves an open-ended range against the stored size', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { headers: { Range: 'bytes=4000-' } }
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(VIDEO.slice(4000));
    expect(response.headers.get('Content-Range')).toBe(`bytes 4000-4095/${VIDEO.length}`);
  });

  it('answers a HEAD with a range from metadata, and sends no bytes', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { method: 'HEAD', headers: { Range: 'bytes=0-1023' } }
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Range')).toBe(`bytes 0-1023/${VIDEO.length}`);
    expect(media.gets).toEqual([]);
  });

  it('416s a range past the end, and says how big the object really is', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { headers: { Range: 'bytes=99999-' } }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(`bytes */${VIDEO.length}`);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(media.gets).toEqual([]);
  });

  it('404s a range for an object that is not there', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(
      mediaBucket(),
      { mediaId: MISSING_MEDIA_ID, variant: 'orig.mp4' },
      { headers: { Range: 'bytes=0-1023' } }
    );

    expect(response.status).toBe(404);
  });

  it('serves the whole object when If-Range names another version', async () => {
    // A conditional whose failure mode is a correct full response, never an
    // error.
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { headers: { Range: 'bytes=0-1023', 'If-Range': '"some-other-etag"' } }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(VIDEO);
    expect(media.ranges).toEqual([]);
  });

  it('honours a range when If-Range still names what we hold', async () => {
    const media = mediaBucket();
    const { response } = await fetchMedia(
      media,
      { variant: 'orig.mp4' },
      { headers: { Range: 'bytes=0-1023', 'If-Range': `"${key('orig.mp4')}"` } }
    );

    expect(response.status).toBe(206);
  });
});

describe('media refusals', () => {
  it('403s a tampered signature', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await signedMediaUrl({ variant: 'orig.mp4' });
    const response = await worker.fetch(
      new Request(url.replace(/sig=[^&]+/, 'sig=nope')),
      fakeEnv({ MEDIA: mediaBucket() as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('403s a URL whose classroom was rewritten', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const media = mediaBucket();
    const url = (await signedMediaUrl({ variant: 'orig.mp4' })).replace(CLASSROOM, OTHER_CLASSROOM);
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ MEDIA: media as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'bad-signature' });
    expect(media.gets).toEqual([]);
  });

  it('403s a URL whose variant was rewritten', async () => {
    // A poster-frame URL must not be editable into the 2 GB original.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const media = fakeBucket({
      [key('poster.webp')]: { body: 'poster', contentType: 'image/webp' },
      [key('orig.mp4')]: { body: VIDEO, contentType: 'video/mp4' },
    });
    const url = (await signedMediaUrl({ variant: 'poster.webp' })).replace(
      'poster.webp',
      'orig.mp4'
    );
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ MEDIA: media as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(403);
    expect(media.gets).toEqual([]);
  });

  it('403s an expired media URL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(mediaBucket(), {
      variant: 'orig.mp4',
      exp: nowSeconds() - 86400,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('403s a media URL carrying an unsigned param', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = `${await signedMediaUrl({ variant: 'orig.mp4' })}&w=800`;
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ MEDIA: mediaBucket() as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });

  it('503s a verified media URL when the MEDIA binding is missing', async () => {
    // The URL is perfectly good; the deploy is not. Without this the route
    // would read `undefined.head` and surface as `500 internal error`, which
    // sends an operator looking at the signing code instead of the binding.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(
      mediaBucket(),
      { variant: 'orig.mp4' },
      {},
      { MEDIA: undefined }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'media not configured' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(warn).toHaveBeenCalledWith('[content] media binding missing');
  });

  it('still serves blobs when only the MEDIA binding is missing', async () => {
    // `isConfigured` deliberately does not cover MEDIA: one lost binding must
    // not take the other two shapes down with it.
    const cache = fakeBucket({ [`blobs/${BLOB_SHA}`]: { body: 'png-bytes' } });
    const response = await worker.fetch(
      new Request(await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' })),
      fakeEnv({
        CACHE: cache as unknown as R2Bucket,
        MEDIA: undefined as unknown as R2Bucket,
      }),
      fakeContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('png-bytes');
  });

  it('405s a write to a media URL', async () => {
    const url = await signedMediaUrl({ variant: 'orig.mp4' });
    const response = await worker.fetch(
      new Request(url, { method: 'POST' }),
      fakeEnv({ MEDIA: mediaBucket() as unknown as R2Bucket }),
      fakeContext()
    );

    expect(response.status).toBe(405);
  });
});

describe('media cache-control', () => {
  it.each([
    ['month', /^public, max-age=\d+, immutable$/],
    ['week', /^public, max-age=\d+, immutable$/],
  ] as const)('pins %s media at the edge', async (tier, expected) => {
    const { response } = await fetchMedia(mediaBucket(), { variant: 'orig.mp4', tier });
    expect(response.headers.get('Cache-Control')).toMatch(expected);
  });

  it.each(['edit', 'download'] as const)('keeps %s media out of shared caches', async tier => {
    const { response } = await fetchMedia(mediaBucket(), { variant: 'orig.mp4', tier });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('media downloads', () => {
  const FILENAME = 'Week 3 — Recursion.mp4';
  const DISPOSITION =
    `attachment; filename="Week 3 _ Recursion.mp4"; ` +
    `filename*=UTF-8''Week%203%20%E2%80%94%20Recursion.mp4`;

  it('serves a download-tier URL as an attachment', async () => {
    const { response } = await fetchMedia(mediaBucket(), {
      variant: 'orig.mp4',
      tier: 'download',
      dl: FILENAME,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
    // A bare `sandbox` blocks the download it is being asked to perform.
    expect(response.headers.get('Content-Security-Policy')).toBe(DOWNLOAD_CSP);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
  });

  it('attaches the filename to a 206 as well', async () => {
    const { response } = await fetchMedia(
      mediaBucket(),
      { variant: 'orig.mp4', tier: 'download', dl: FILENAME },
      { headers: { Range: 'bytes=0-1023' } }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Disposition')).toBe(DISPOSITION);
  });

  it('leaves a 404 alone rather than telling the browser to save it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await fetchMedia(mediaBucket(), {
      mediaId: MISSING_MEDIA_ID,
      variant: 'orig.mp4',
      tier: 'download',
      dl: FILENAME,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('ignores a dl that was signed onto a cacheable tier', async () => {
    // `signMediaUrl` refuses to mint this, so only the signing key could have
    // produced it — and the tier is what decides cacheability. A per-viewer
    // filename must never ride an immutable reply a shared cache may keep.
    const { response } = await fetchMedia(mediaBucket(), {
      variant: 'orig.mp4',
      tier: 'month',
      dl: FILENAME,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
  });

  it('serves a download URL with no filename as an ordinary reply', async () => {
    const { response } = await fetchMedia(mediaBucket(), {
      variant: 'orig.mp4',
      tier: 'download',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(STRICT_CSP);
  });
});

describe('the blob and missing shapes are untouched', () => {
  it('still 404s the resolver dangling-reference URL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent('assets/logo.png')}`),
      fakeEnv(),
      fakeContext()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'missing' });
  });

  it('403s an unknown third segment, media-like or not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await worker.fetch(
      new Request(`${ORIGIN}/c/${CLASSROOM}/medias/${MEDIA_ID}/orig.mp4`),
      fakeEnv(),
      fakeContext()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });
});
