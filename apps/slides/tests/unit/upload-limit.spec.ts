/**
 * Unit tests for the upload size gates.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test uses web APIs (`Headers`, `ReadableStream`, `Response`)
 * and nothing else.
 *
 * The contract that matters: `Content-Length` is a hint, not a limit. A request
 * that declares nothing, or declares a comfortable size and then sends far
 * more, must still be cut off — which is why the byte count while reading is a
 * separate gate and not an optimisation of the first one.
 *
 * The slot limit at the bottom is the other half of the same problem: the size
 * cap bounds ONE upload, and says nothing about ten of them arriving together.
 */

import { test, expect } from '@playwright/test';

import {
  MULTIPART_OVERHEAD_BYTES,
  UploadTooLargeError,
  declaredBodyBytes,
  declaredBodyTooLarge,
  readLimitedBody,
  readLimitedChunks,
  readLimitedFormData,
  uploadBodyLimit,
} from '../../app/utils/uploadLimit.ts';
import {
  MAX_CONCURRENT_UPLOADS,
  acquireUploadSlot,
  releaseUploadSlot,
  uploadsInFlight,
} from '../../app/utils/uploadConcurrency.server.ts';

/** A stream that hands over `count` chunks of `size` bytes. */
function streamOf(count: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

test.describe('the declared size', () => {
  test('is read when the client sends one', () => {
    expect(declaredBodyBytes(new Headers({ 'content-length': '2048' }))).toBe(2048);
  });

  test('is null — not zero — when there is none', () => {
    // A chunked upload sends no Content-Length at all. Reading that as an empty
    // body would wave it straight past the first gate.
    expect(declaredBodyBytes(new Headers())).toBeNull();
    expect(declaredBodyBytes(new Headers({ 'content-length': '' }))).toBeNull();
    expect(declaredBodyBytes(new Headers({ 'content-length': 'lots' }))).toBeNull();
    expect(declaredBodyBytes(new Headers({ 'content-length': '-5' }))).toBeNull();
  });

  test('refuses only when it is already over the cap', () => {
    expect(declaredBodyTooLarge(new Headers({ 'content-length': '101' }), 100)).toBe(true);
    expect(declaredBodyTooLarge(new Headers({ 'content-length': '100' }), 100)).toBe(false);
    // Undeclared is NOT refused here — the streaming count is what catches it.
    expect(declaredBodyTooLarge(new Headers(), 100)).toBe(false);
  });
});

test.describe('the transport cap', () => {
  test('leaves room for the multipart envelope around the file', () => {
    expect(uploadBodyLimit(75 * 1024 * 1024)).toBe(75 * 1024 * 1024 + MULTIPART_OVERHEAD_BYTES);
  });
});

test.describe('reading with a limit', () => {
  test('returns the whole body when it fits', async () => {
    const bytes = await readLimitedBody(streamOf(4, 25), 100);
    expect(bytes.byteLength).toBe(100);
  });

  test('throws as soon as the count crosses, without buffering the rest', async () => {
    // 100 chunks of 10 bytes against a 25 byte cap: the third chunk crosses it,
    // and the remaining 97 are never read.
    await expect(readLimitedBody(streamOf(100, 10), 25)).rejects.toBeInstanceOf(
      UploadTooLargeError
    );
  });

  test('parses a multipart body that fits', async () => {
    const form = new FormData();
    form.set('source', 'file');
    form.set('file', new File([new Uint8Array(64)], 'lecture.pdf'), 'lecture.pdf');
    const request = new Request('https://slides.test/cs52/new', { method: 'POST', body: form });

    const parsed = await readLimitedFormData(request, 1024 * 1024);
    expect(parsed.get('source')).toBe('file');
    expect((parsed.get('file') as File).name).toBe('lecture.pdf');
  });

  test('refuses an over-cap multipart body', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(4096)], 'lecture.pdf'), 'lecture.pdf');
    const request = new Request('https://slides.test/cs52/new', { method: 'POST', body: form });

    await expect(readLimitedFormData(request, 512)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  test('a lying Content-Length does not get a body past the cap', async () => {
    // Declares 10 bytes, sends 4 KB. The declared-size gate waves it through
    // and the streaming count is the one that stops it.
    const request = new Request('https://slides.test/cs52/new', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
      body: streamOf(4, 1024),
      // Node requires this for a streaming request body.
      duplex: 'half',
    } as RequestInit);

    await expect(readLimitedFormData(request, 512)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  test('carries a 413 so a route does not have to guess a status', () => {
    const error = new UploadTooLargeError(75);
    expect(error.status).toBe(413);
    expect(error.code).toBe('UPLOAD_TOO_LARGE');
  });
});

test.describe('reading without joining', () => {
  test('hands back the chunks as they arrived', async () => {
    // A 75 MB upload is large enough that every avoidable copy is another
    // 75 MB held at the same moment, so the form-data path streams these into
    // the parser rather than concatenating them first.
    const { chunks, size } = await readLimitedChunks(streamOf(4, 25), 100);
    expect(chunks).toHaveLength(4);
    expect(size).toBe(100);
  });

  test('keeps nothing once it has decided to refuse', async () => {
    await expect(readLimitedChunks(streamOf(100, 10), 25)).rejects.toBeInstanceOf(
      UploadTooLargeError
    );
  });
});

test.describe('the concurrency limit', () => {
  test('hands out a fixed number of slots and then says no', () => {
    const taken: boolean[] = [];
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) taken.push(acquireUploadSlot());
    expect(taken.every(Boolean)).toBe(true);
    expect(uploadsInFlight()).toBe(MAX_CONCURRENT_UPLOADS);

    // The one over the line is refused rather than queued: a queued upload
    // holds its socket open for as long as the ones ahead of it take, which is
    // the same resource problem one step later.
    expect(acquireUploadSlot()).toBe(false);

    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) releaseUploadSlot();
    expect(uploadsInFlight()).toBe(0);
  });

  test('a release frees exactly one slot', () => {
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) acquireUploadSlot();
    expect(acquireUploadSlot()).toBe(false);

    releaseUploadSlot();
    expect(acquireUploadSlot()).toBe(true);

    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) releaseUploadSlot();
  });

  test('never counts below zero, whatever a caller does', () => {
    // A `finally` that runs twice, or one that runs after an acquire returned
    // false, must not leave the process with more slots than it has.
    releaseUploadSlot();
    releaseUploadSlot();
    expect(uploadsInFlight()).toBe(0);
  });
});
