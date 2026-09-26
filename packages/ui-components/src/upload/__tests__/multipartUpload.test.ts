/**
 * The upload client against a fake server.
 *
 * Everything interesting about this module is failure handling — a part that
 * 500s, a signature that went stale while the one before it was still flying,
 * a cancel in the middle — and none of it is reachable from a happy-path
 * integration test. So the whole surface is driven through a `fetch` double
 * that can be told to fail on exactly the call we want to fail.
 *
 * The double is deliberately literal about the transport: it hands back real
 * `Response` objects with real headers, so the ETag path is exercised as it
 * would be in a browser rather than through a hand-shaped object.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MultipartUploadError,
  uploadMultipart,
  type MultipartUploadProgress,
} from '../multipartUpload.ts';

const BASE = '/api/media';
const MEDIA_ID = '1f4c2e7a-0d61-4f52-9f6b-2a3c9d8e7b10';
const PART_SIZE = 4;

/** 10 bytes at a 4-byte part size = three parts, the last one short. */
const videoFile = () => new File([new Uint8Array(10)], 'lecture.mp4', { type: 'video/mp4' });

interface Call {
  url: string;
  method: string;
  body: unknown;
  bodySize?: number;
  contentType?: string | null;
}

interface ServerOptions {
  create?: () => Response;
  parts?: (call: number, partNumbers: number[]) => Response;
  put?: (partNumber: number, attempt: number) => Response | Promise<Response> | Error;
  complete?: () => Response;
  partCount?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const putOk = (partNumber: number) =>
  new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });

/**
 * A stand-in for the four routes plus R2.
 *
 * Part URLs carry their own part number and a mint counter, so a test can tell
 * a re-signed URL from the one it replaced without reaching into the module.
 */
function makeServer(options: ServerOptions = {}) {
  const calls: Call[] = [];
  const attempts = new Map<number, number>();
  let partsCalls = 0;

  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const isPut = method === 'PUT';
    const body = !isPut && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    calls.push({
      url,
      method,
      body,
      bodySize: isPut ? (init.body as Blob).size : undefined,
      contentType: isPut ? new Headers(init.headers).get('Content-Type') : undefined,
    });

    if (url === `${BASE}/uploads` && method === 'POST') {
      return (
        options.create?.() ??
        json(200, {
          mediaId: MEDIA_ID,
          uploadId: 'upload-1',
          partSize: PART_SIZE,
          partCount: options.partCount ?? 3,
          contentType: 'video/mp4',
        })
      );
    }

    if (url === `${BASE}/uploads/${MEDIA_ID}/parts`) {
      partsCalls += 1;
      const partNumbers = body.partNumbers as number[];
      return (
        options.parts?.(partsCalls, partNumbers) ??
        json(200, {
          urls: partNumbers.map(partNumber => ({
            partNumber,
            url: `https://r2.example/part/${partNumber}?mint=${partsCalls}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          })),
        })
      );
    }

    if (url === `${BASE}/uploads/${MEDIA_ID}/complete`) {
      return options.complete?.() ?? json(200, { mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}` });
    }

    if (url === `${BASE}/${MEDIA_ID}` && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (isPut) {
      const partNumber = Number(url.match(/\/part\/(\d+)/)?.[1]);
      const attempt = (attempts.get(partNumber) ?? 0) + 1;
      attempts.set(partNumber, attempt);
      const outcome = options.put?.(partNumber, attempt);
      if (outcome instanceof Error) throw outcome;
      return outcome ?? putOk(partNumber);
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    fetchMock,
    of: (method: string, match?: string) =>
      calls.filter(c => c.method === method && (!match || c.url.includes(match))),
    partsCalls: () => partsCalls,
  };
}

/**
 * Drive a run that has to sit through backoff without sitting through it.
 *
 * Repeated `advanceTimersByTimeAsync` rather than `runAllTimersAsync`: the next
 * backoff is only scheduled once the PUT before it has failed, so the loop has
 * to hand control back to the promise chain between advances.
 */
async function settleThroughBackoff<T>(promise: Promise<T>): Promise<T | MultipartUploadError> {
  const settled = promise.then(
    value => value,
    (error: MultipartUploadError) => error
  );
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(10_000);
  return settled;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uploadMultipart — happy path', () => {
  it('creates, signs, PUTs every part and completes', async () => {
    const server = makeServer();
    const progress: MultipartUploadProgress[] = [];

    const result = await uploadMultipart({
      file: videoFile(),
      classroomId: 'class-1',
      options: { optimise: true, keepOriginal: false, allowDownload: true },
      endpoints: { base: BASE },
      onProgress: p => progress.push(p),
    });

    expect(result).toEqual({ mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}` });

    expect(server.of('POST', '/uploads')[0].body).toEqual({
      classroomId: 'class-1',
      filename: 'lecture.mp4',
      sizeBytes: 10,
      options: { optimise: true, keepOriginal: false, allowDownload: true },
    });

    // Three parts fit in one batch of eight, so one signing round trip.
    expect(server.partsCalls()).toBe(1);
    expect(server.of('POST', '/parts')[0].body).toEqual({ partNumbers: [1, 2, 3] });

    const puts = server.of('PUT');
    expect(puts).toHaveLength(3);
    // The last part is the 2-byte remainder, not a padded 4.
    expect(puts.map(p => p.bodySize).sort()).toEqual([2, 4, 4]);
    // The content type the create call assigned, or the signature will not match.
    expect(new Set(puts.map(p => p.contentType))).toEqual(new Set(['video/mp4']));

    expect(server.of('POST', '/complete')[0].body).toEqual({
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });

    // Nothing to clean up when nothing went wrong.
    expect(server.of('DELETE')).toHaveLength(0);
    expect(progress.at(0)).toEqual({ sentBytes: 0, totalBytes: 10, part: 0, partCount: 3 });
    expect(progress.at(-1)?.sentBytes).toBe(10);
  });

  it('asks for URLs in batches of eight', async () => {
    const server = makeServer({ partCount: 20 });

    await uploadMultipart({
      file: new File([new Uint8Array(80)], 'long.mp4'),
      classroomId: 'class-1',
      endpoints: { base: BASE },
    });

    expect(
      server.of('POST', '/parts').map(c => (c.body as { partNumbers: number[] }).partNumbers)
    ).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9, 10, 11, 12, 13, 14, 15, 16],
      [17, 18, 19, 20],
    ]);
  });
});

describe('uploadMultipart — retries', () => {
  it('retries a part that 500s and finishes without re-uploading the others', async () => {
    vi.useFakeTimers();
    const server = makeServer({
      put: (partNumber, attempt) =>
        partNumber === 2 && attempt === 1
          ? new Response('boom', { status: 500 })
          : putOk(partNumber),
    });

    const result = await settleThroughBackoff(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    );

    expect(result).toEqual({ mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}` });
    // Four PUTs: part 2 twice, parts 1 and 3 once each.
    expect(server.of('PUT')).toHaveLength(4);
    expect(server.of('DELETE')).toHaveLength(0);
  });

  it('retries a network failure and a 429, then gives up after three tries', async () => {
    vi.useFakeTimers();
    const server = makeServer({
      put: (partNumber, attempt) => {
        if (partNumber !== 1) return putOk(partNumber);
        if (attempt === 1) return new TypeError('Failed to fetch');
        return new Response('slow down', { status: 429 });
      },
    });

    const result = await settleThroughBackoff(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    );

    expect(result).toBeInstanceOf(MultipartUploadError);
    expect((result as MultipartUploadError).code).toBe('NETWORK');
    // One attempt plus the three the backoff schedule allows.
    expect(server.of('PUT').filter(c => c.url.includes('/part/1'))).toHaveLength(4);
    // A dead upload must not keep holding quota.
    expect(server.of('DELETE')).toHaveLength(1);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const server = makeServer({
      put: partNumber =>
        partNumber === 1 ? new Response('nope', { status: 400 }) : putOk(partNumber),
    });

    await expect(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    ).rejects.toMatchObject({ code: 'NETWORK', status: 400 });

    expect(server.of('PUT').filter(c => c.url.includes('/part/1'))).toHaveLength(1);
  });
});

describe('uploadMultipart — expired signatures', () => {
  it('re-signs the outstanding parts when R2 says the URL expired', async () => {
    const server = makeServer({
      put: (partNumber, attempt) =>
        partNumber === 1 && attempt === 1
          ? new Response(
              '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
              {
                status: 403,
              }
            )
          : putOk(partNumber),
    });

    const result = await uploadMultipart({
      file: videoFile(),
      classroomId: 'class-1',
      endpoints: { base: BASE },
    });

    expect(result.ref).toBe(`media://${MEDIA_ID}`);
    // A second signing round trip, and the retry used the fresh mint.
    expect(server.partsCalls()).toBe(2);
    expect(server.of('PUT').filter(c => c.url.includes('mint=2'))).not.toHaveLength(0);
  });

  it('re-signs before the PUT when the URL it holds has already passed its expiry', async () => {
    const server = makeServer({
      parts: (call, partNumbers) =>
        json(200, {
          urls: partNumbers.map(partNumber => ({
            partNumber,
            url: `https://r2.example/part/${partNumber}?mint=${call}`,
            // The first mint is already dead on arrival; the second is fresh.
            expiresAt: new Date(Date.now() + (call === 1 ? -1_000 : 15 * 60_000)).toISOString(),
          })),
        }),
    });

    await uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } });

    expect(server.partsCalls()).toBeGreaterThan(1);
    // Not one byte was sent against a signature we knew was dead.
    expect(server.of('PUT').filter(c => c.url.includes('mint=1'))).toHaveLength(0);
  });
});

describe('uploadMultipart — cancellation', () => {
  it('stops, cleans up and rejects as ABORTED', async () => {
    const controller = new AbortController();
    const server = makeServer({
      put: partNumber => {
        if (partNumber !== 1) return putOk(partNumber);
        controller.abort();
        return Object.assign(new DOMException('The operation was aborted.', 'AbortError'));
      },
    });

    const error = await uploadMultipart({
      file: videoFile(),
      classroomId: 'class-1',
      endpoints: { base: BASE },
      signal: controller.signal,
    }).catch((e: MultipartUploadError) => e);

    expect(error).toBeInstanceOf(MultipartUploadError);
    expect((error as MultipartUploadError).code).toBe('ABORTED');
    expect(server.of('DELETE')).toHaveLength(1);
    expect(server.of('DELETE')[0].url).toBe(`${BASE}/${MEDIA_ID}`);
    expect(server.of('POST', '/complete')).toHaveLength(0);
  });

  it('refuses before it creates anything when the signal is already aborted', async () => {
    const server = makeServer();
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadMultipart({
        file: videoFile(),
        classroomId: 'class-1',
        endpoints: { base: BASE },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'ABORTED' });

    expect(server.calls).toHaveLength(0);
  });
});

describe('uploadMultipart — server error codes', () => {
  it.each([
    [503, 'NOT_CONFIGURED'],
    [403, 'PRO_REQUIRED'],
    [409, 'DELIVERY_REQUIRED'],
    [413, 'FILE_TOO_LARGE'],
    [422, 'KIND_NOT_ALLOWED'],
  ])('surfaces %i as %s, and has nothing to clean up', async (status, code) => {
    const server = makeServer({ create: () => json(status, { error: code }) });

    await expect(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    ).rejects.toMatchObject({ code, status });

    expect(server.of('DELETE')).toHaveLength(0);
  });

  it('reads a 409 by its body code, not by the status table', async () => {
    // Four refusals share 409, so the status alone would call every one of them
    // QUOTA_EXCEEDED and the dialog would tell an owner to delete something.
    makeServer({ create: () => json(409, { error: 'DELIVERY_REQUIRED' }) });

    await expect(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    ).rejects.toMatchObject({ code: 'DELIVERY_REQUIRED', status: 409 });
  });

  it('carries the numbers with QUOTA_EXCEEDED so the dialog can say how much is left', async () => {
    makeServer({
      create: () =>
        json(409, {
          error: 'QUOTA_EXCEEDED',
          usedBytes: 10_500_000_000,
          quotaBytes: 10_737_418_240,
        }),
    });

    const error = await uploadMultipart({
      file: videoFile(),
      classroomId: 'class-1',
      endpoints: { base: BASE },
    }).catch((e: MultipartUploadError) => e);

    expect(error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      usedBytes: 10_500_000_000,
      quotaBytes: 10_737_418_240,
    });
  });

  it.each(['SIZE_MISMATCH', 'VERIFY_FAILED'])(
    'surfaces %s from complete and cleans up after it',
    async code => {
      const server = makeServer({ complete: () => json(409, { error: code }) });

      await expect(
        uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
      ).rejects.toMatchObject({ code });

      expect(server.of('DELETE')).toHaveLength(1);
    }
  );

  it('falls back to NETWORK when the server answers with no usable body', async () => {
    makeServer({ create: () => new Response('<html>gateway</html>', { status: 502 }) });

    await expect(
      uploadMultipart({ file: videoFile(), classroomId: 'class-1', endpoints: { base: BASE } })
    ).rejects.toMatchObject({ code: 'NETWORK', status: 502 });
  });
});

describe('uploadMultipart — progress', () => {
  it('never goes backwards, never double-counts a retried part, and ends at the total', async () => {
    vi.useFakeTimers();
    makeServer({
      partCount: 5,
      put: (partNumber, attempt) =>
        attempt === 1 && (partNumber === 2 || partNumber === 4)
          ? new Response('boom', { status: 503 })
          : putOk(partNumber),
    });

    const progress: MultipartUploadProgress[] = [];
    await settleThroughBackoff(
      uploadMultipart({
        file: new File([new Uint8Array(20)], 'lecture.mp4'),
        classroomId: 'class-1',
        endpoints: { base: BASE },
        onProgress: p => progress.push(p),
      })
    );

    expect(progress.at(0)?.sentBytes).toBe(0);
    expect(progress.at(-1)?.sentBytes).toBe(20);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i].sentBytes).toBeGreaterThan(progress[i - 1].sentBytes);
      expect(progress[i].sentBytes).toBeLessThanOrEqual(progress[i].totalBytes);
      expect(progress[i].partCount).toBe(5);
    }
    // One report per part, plus the opening zero.
    expect(progress).toHaveLength(6);
  });
});
