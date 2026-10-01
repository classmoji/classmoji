/**
 * The video job's bucket I/O: files stream up (one PUT, or equal-sized
 * multipart parts with an abort on failure) and down (exactly the row's size,
 * never more), and nothing is held in memory as a Buffer.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PART_BYTES,
  PART_TRIES,
  downloadToFile,
  isTransientS3Error,
  sha256File,
  uploadFile,
  type MediaStore,
} from '../r2Objects.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'r2objects-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeStore(
  send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>
) {
  const client = { send: vi.fn(send) };
  return { store: { client, bucket: 'b' } as unknown as MediaStore, send: client.send };
}

async function drain(body: unknown): Promise<number> {
  let n = 0;
  for await (const chunk of body as Readable) n += (chunk as Buffer).length;
  return n;
}

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status } });

const NO_WAIT = { retryDelayMs: () => 0 };

describe('uploadFile', () => {
  it('sends a small file as one streamed PUT with its length and type', async () => {
    const file = join(dir, 'poster.jpg');
    await writeFile(file, Buffer.alloc(1234, 1));
    const { store, send } = fakeStore(async command => {
      const input = (command as PutObjectCommand).input;
      expect(input.Body).toBeInstanceOf(Readable);
      expect(await drain(input.Body)).toBe(1234);
      return {};
    });
    await uploadFile(store, 'k', file, 1234, 'image/jpeg');
    expect(send).toHaveBeenCalledTimes(1);
    const put = send.mock.calls[0][0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'b',
      Key: 'k',
      ContentLength: 1234,
      ContentType: 'image/jpeg',
    });
  });

  it('splits a large file into equal parts (last one shorter), streamed, then completes', async () => {
    const size = 2 * PART_BYTES + 10;
    const file = join(dir, 'web.mp4');
    await writeFile(file, Buffer.alloc(size, 7));
    const parts: Array<{ n: number; len: number; streamed: number }> = [];
    const { store, send } = fakeStore(async command => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'u1' };
      if (command instanceof UploadPartCommand) {
        const input = command.input;
        parts.push({
          n: Number(input.PartNumber),
          len: Number(input.ContentLength),
          streamed: await drain(input.Body),
        });
        return { ETag: `"e${input.PartNumber}"` };
      }
      if (command instanceof CompleteMultipartUploadCommand) return {};
      throw new Error('unexpected');
    });
    await uploadFile(store, 'k', file, size, 'video/mp4');
    parts.sort((a, b) => a.n - b.n);
    expect(parts).toEqual([
      { n: 1, len: PART_BYTES, streamed: PART_BYTES },
      { n: 2, len: PART_BYTES, streamed: PART_BYTES },
      { n: 3, len: 10, streamed: 10 },
    ]);
    const complete = send.mock.calls[
      send.mock.calls.length - 1
    ][0] as CompleteMultipartUploadCommand;
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload?.Parts).toEqual([
      { ETag: '"e1"', PartNumber: 1 },
      { ETag: '"e2"', PartNumber: 2 },
      { ETag: '"e3"', PartNumber: 3 },
    ]);
  }, 30_000);

  it('retries a failed PUT with a fresh stream each time', async () => {
    const file = join(dir, 'poster.jpg');
    await writeFile(file, Buffer.alloc(1234, 1));
    const bodies: unknown[] = [];
    let calls = 0;
    const { store, send } = fakeStore(async command => {
      const body = (command as PutObjectCommand).input.Body;
      bodies.push(body);
      expect(await drain(body)).toBe(1234);
      if (++calls < 3) throw calls === 1 ? httpError(503) : new Error('socket hang up');
      return {};
    });
    await uploadFile(store, 'k', file, 1234, 'image/jpeg', NO_WAIT);
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(bodies).size).toBe(3);
  });

  it('gives up on a PUT after PART_TRIES, and at once on a 4xx', async () => {
    const file = join(dir, 'poster.jpg');
    await writeFile(file, 'x');
    const flaky = fakeStore(async () => {
      throw httpError(500);
    });
    await expect(uploadFile(flaky.store, 'k', file, 1, 'image/jpeg', NO_WAIT)).rejects.toThrow(
      'HTTP 500'
    );
    expect(flaky.send).toHaveBeenCalledTimes(PART_TRIES);
    const denied = fakeStore(async () => {
      throw httpError(403);
    });
    await expect(uploadFile(denied.store, 'k', file, 1, 'image/jpeg', NO_WAIT)).rejects.toThrow(
      'HTTP 403'
    );
    expect(denied.send).toHaveBeenCalledTimes(1);
  });

  it('retries one part with a fresh ranged stream of the same bytes', async () => {
    const size = PART_BYTES + 10;
    const file = join(dir, 'web.mp4');
    await writeFile(file, '');
    await truncate(file, size);
    const tries: Array<{ n: number; streamed: number }> = [];
    let failedOnce = false;
    const { store, send } = fakeStore(async command => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'u1' };
      if (command instanceof UploadPartCommand) {
        const n = Number(command.input.PartNumber);
        tries.push({ n, streamed: await drain(command.input.Body) });
        if (n === 2 && !failedOnce) {
          failedOnce = true;
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        }
        return { ETag: `"e${n}"` };
      }
      return {};
    });
    await uploadFile(store, 'k', file, size, 'video/mp4', NO_WAIT);
    expect(tries.filter(t => t.n === 2)).toEqual([
      { n: 2, streamed: 10 },
      { n: 2, streamed: 10 },
    ]);
    expect(send.mock.calls.some(([c]) => c instanceof CompleteMultipartUploadCommand)).toBe(true);
  }, 30_000);

  it('a part that gives up cancels the parts in flight and starts no more', async () => {
    const size = 5 * PART_BYTES + 1; // six parts, four at a time
    const file = join(dir, 'web.mp4');
    await writeFile(file, '');
    await truncate(file, size);
    const started: number[] = [];
    const cancelled: number[] = [];
    const { store, send } = fakeStore(async (command, options) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'u1' };
      if (command instanceof UploadPartCommand) {
        const n = Number(command.input.PartNumber);
        started.push(n);
        (command.input.Body as Readable).destroy();
        if (n === 1) {
          await new Promise(r => setImmediate(r));
          throw httpError(400);
        }
        return new Promise((_, reject) =>
          options?.abortSignal?.addEventListener('abort', () => {
            cancelled.push(n);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          })
        );
      }
      return {};
    });
    await expect(uploadFile(store, 'k', file, size, 'video/mp4', NO_WAIT)).rejects.toThrow(
      'HTTP 400'
    );
    expect(started.sort()).toEqual([1, 2, 3, 4]);
    expect(cancelled.sort()).toEqual([2, 3, 4]);
    const kinds = send.mock.calls.map(([c]) => (c as object).constructor.name);
    expect(kinds.at(-1)).toBe('AbortMultipartUploadCommand');
    expect(kinds).not.toContain('CompleteMultipartUploadCommand');
  }, 30_000);

  it('aborts the multipart upload when a part fails', async () => {
    const size = PART_BYTES + 1;
    const file = join(dir, 'web.mp4');
    await writeFile(file, Buffer.alloc(size));
    const { store, send } = fakeStore(async command => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'u1' };
      if (command instanceof UploadPartCommand) {
        await drain(command.input.Body);
        throw new Error('R2 500');
      }
      return {};
    });
    await expect(uploadFile(store, 'k', file, size, 'video/mp4', NO_WAIT)).rejects.toThrow(
      'R2 500'
    );
    expect(send.mock.calls.some(([c]) => c instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(send.mock.calls.some(([c]) => c instanceof CompleteMultipartUploadCommand)).toBe(false);
  }, 30_000);
});

describe('downloadToFile', () => {
  const serving = (bytes: number, contentLength: number | undefined = bytes) =>
    fakeStore(async command => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return { Body: Readable.from([Buffer.alloc(bytes, 3)]), ContentLength: contentLength };
    }).store;

  it('streams exactly the expected bytes to disk', async () => {
    const file = join(dir, 'input');
    await downloadToFile(serving(500), 'k', file, 500);
    expect((await stat(file)).size).toBe(500);
  });

  it("refuses a stored object whose ContentLength is not the row's size, before streaming", async () => {
    for (const declared of [10, 501]) {
      const file = join(dir, `input-${declared}`);
      await expect(downloadToFile(serving(declared), 'k', file, 500)).rejects.toMatchObject({
        code: 'ORIGINAL_MISMATCH',
      });
      await expect(stat(file)).rejects.toThrow();
    }
  });

  it('refuses a stream that runs past the declared size, stopping at the limit', async () => {
    await expect(
      downloadToFile(serving(501, 500), 'k', join(dir, 'input'), 500)
    ).rejects.toMatchObject({ code: 'ORIGINAL_MISMATCH' });
  });

  it('a stream that ends short of the declared size is a broken transfer: retried', async () => {
    const error = await downloadToFile(serving(10, 500), 'k', join(dir, 'input'), 500).catch(
      e => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBeUndefined();
    expect(error.message).toMatch(/ended at 10 of 500/);
  });

  it('a missing original is a refusal', async () => {
    const { store } = fakeStore(async () => {
      throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    });
    await expect(downloadToFile(store, 'k', join(dir, 'input'), 1)).rejects.toMatchObject({
      code: 'ORIGINAL_MISSING',
    });
  });

  it('a transient GET failure is not a refusal', async () => {
    const { store } = fakeStore(async () => {
      throw Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } });
    });
    const error = await downloadToFile(store, 'k', join(dir, 'input'), 1).catch(e => e);
    expect(error.code).toBeUndefined();
  });
});

describe('sha256File', () => {
  it('hashes the file', async () => {
    const file = join(dir, 'x');
    await writeFile(file, 'abc');
    expect(await sha256File(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect((await readFile(file)).toString()).toBe('abc');
  });
});

describe('isTransientS3Error', () => {
  it('retries network faults, 5xx, 408, 429; not other 4xx or a cancel', () => {
    expect(isTransientS3Error(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientS3Error(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    for (const s of [500, 502, 503, 408, 429]) expect(isTransientS3Error(httpError(s))).toBe(true);
    for (const s of [400, 403, 404]) expect(isTransientS3Error(httpError(s))).toBe(false);
    expect(isTransientS3Error(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('mediaStore', () => {
  it('builds the client with a connect timeout and a 60 s idle socket timeout', async () => {
    const { mediaStore } = await import('../r2Objects.ts');
    Object.assign(process.env, {
      MEDIA_R2_ACCOUNT_ID: 'acct',
      MEDIA_R2_ACCESS_KEY_ID: 'id',
      MEDIA_R2_SECRET_ACCESS_KEY: 'secret',
      MEDIA_R2_BUCKET: 'bucket',
    });
    try {
      const store = mediaStore();
      const handler = store?.client.config.requestHandler as unknown as {
        configProvider: Promise<{ socketTimeout?: number; connectionTimeout?: number }>;
      };
      const config = await handler.configProvider;
      expect(config).toMatchObject({ socketTimeout: 60_000, connectionTimeout: 10_000 });
    } finally {
      for (const k of [
        'MEDIA_R2_ACCOUNT_ID',
        'MEDIA_R2_ACCESS_KEY_ID',
        'MEDIA_R2_SECRET_ACCESS_KEY',
        'MEDIA_R2_BUCKET',
      ]) {
        delete process.env[k];
      }
    }
  });
});
