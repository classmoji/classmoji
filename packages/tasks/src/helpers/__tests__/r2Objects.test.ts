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
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PART_BYTES,
  downloadToFile,
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

function fakeStore(send: (command: unknown) => Promise<unknown>) {
  const client = { send: vi.fn(send) };
  return { store: { client, bucket: 'b' } as unknown as MediaStore, send: client.send };
}

async function drain(body: unknown): Promise<number> {
  let n = 0;
  for await (const chunk of body as Readable) n += (chunk as Buffer).length;
  return n;
}

describe('uploadFile', () => {
  it('sends a small file as one streamed PUT with its length and type', async () => {
    const file = join(dir, 'poster.webp');
    await writeFile(file, Buffer.alloc(1234, 1));
    const { store, send } = fakeStore(async command => {
      const input = (command as PutObjectCommand).input;
      expect(input.Body).toBeInstanceOf(Readable);
      expect(await drain(input.Body)).toBe(1234);
      return {};
    });
    await uploadFile(store, 'k', file, 1234, 'image/webp');
    expect(send).toHaveBeenCalledTimes(1);
    const put = send.mock.calls[0][0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'b',
      Key: 'k',
      ContentLength: 1234,
      ContentType: 'image/webp',
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
    await expect(uploadFile(store, 'k', file, size, 'video/mp4')).rejects.toThrow('R2 500');
    expect(send.mock.calls.some(([c]) => c instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(send.mock.calls.some(([c]) => c instanceof CompleteMultipartUploadCommand)).toBe(false);
  }, 30_000);
});

describe('downloadToFile', () => {
  const serving = (bytes: number) =>
    fakeStore(async command => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return { Body: Readable.from([Buffer.alloc(bytes, 3)]) };
    }).store;

  it('streams exactly the expected bytes to disk', async () => {
    const file = join(dir, 'input');
    await downloadToFile(serving(500), 'k', file, 500);
    expect((await stat(file)).size).toBe(500);
  });

  it('refuses more bytes than the row says, stopping at the limit', async () => {
    await expect(downloadToFile(serving(501), 'k', join(dir, 'input'), 500)).rejects.toMatchObject({
      code: 'ORIGINAL_MISMATCH',
    });
  });

  it('refuses fewer bytes than the row says', async () => {
    await expect(downloadToFile(serving(10), 'k', join(dir, 'input'), 500)).rejects.toMatchObject({
      code: 'ORIGINAL_MISMATCH',
    });
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
