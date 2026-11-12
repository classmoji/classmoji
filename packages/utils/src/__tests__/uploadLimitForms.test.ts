import { afterEach, describe, expect, it, vi } from 'vitest';
// A namespace import, so each case below fails on its own assertion rather
// than the whole file failing on a missing export.
import * as limits from '../uploadLimit.ts';

const { UploadTooLargeError, readLimitedFormData } = limits;

const URLENCODED = 'application/x-www-form-urlencoded';
const BOUNDARY = '----form-boundary-7d3f';
const CAP = 16 * 1024 * 1024;

const post = (body: BodyInit, contentType: string, init: RequestInit = {}) =>
  new Request('http://test.local/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    ...init,
  });

/** `count` url-encoded fields, each named `name` or, without one, `f<n>`. */
const fieldsOf = (count: number, name?: string) =>
  Array.from({ length: count }, (_, n) => `${name ?? `f${n}`}=v`).join('&');

/** A stream over `text`, handed over `size` bytes at a time. */
function streamOf(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

describe('the url-encoded field count', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a form of 10,000 fields', async () => {
    const form = await readLimitedFormData(post(fieldsOf(10_000), URLENCODED), CAP);
    expect([...form.keys()]).toHaveLength(10_000);
  });

  it('refuses a form of 10,001 fields before parsing it', async () => {
    const parse = vi.spyOn(Response.prototype, 'formData');
    await expect(
      readLimitedFormData(post(fieldsOf(10_001, 'a'), URLENCODED), CAP)
    ).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('refuses it as it refuses an over-size body: a 413 naming the byte limit', async () => {
    const refusal = await readLimitedFormData(post(fieldsOf(10_001), URLENCODED), CAP).catch(
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(UploadTooLargeError);
    expect((refusal as InstanceType<typeof UploadTooLargeError>).status).toBe(413);
    expect((refusal as InstanceType<typeof UploadTooLargeError>).limitBytes).toBe(CAP);
  });

  it('is the shared limit', () => {
    expect(limits.FORM_FIELDS_MAX).toBe(10_000);
  });

  it('counts across chunk boundaries', async () => {
    const request = post(streamOf(fieldsOf(10_001, 'a'), 7), URLENCODED, {
      duplex: 'half',
    } as RequestInit);
    await expect(readLimitedFormData(request, CAP)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  for (const contentType of [
    'application/x-www-form-urlencoded; x=multipart/form-data',
    'Application/X-WWW-Form-URLEncoded;charset=UTF-8',
    '  application/x-www-form-urlencoded ; charset=utf-8',
  ]) {
    it(`counts the fields of a form sent as ${JSON.stringify(contentType)}`, async () => {
      await expect(
        readLimitedFormData(post(fieldsOf(10_001, 'a'), contentType), CAP)
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });
  }

  it('reads a deck save with its merge choices as its six fields', async () => {
    // The largest url-encoded form posted to a limited reader: an ops save
    // answering a merge report, its values full of `&` and `=` that encoding
    // must keep out of the count.
    const html =
      '<p>Tom &amp; Jerry</p><a href="https://example.test/?a=1&b=2&c=3">x=y&z</a>'.repeat(500);
    const ops = JSON.stringify(
      Array.from({ length: 200 }, (_, n) => ({ op: 'replace', id: `s${n}`, html }))
    );
    const payload = {
      ops,
      base_sha: 'a'.repeat(40),
      content_sha: 'a'.repeat(40),
      sha_source: 'deck',
      resolutions: JSON.stringify(
        Array.from({ length: 300 }, (_, n) => ({ id: `s${n}`, choose: 'theirs' }))
      ),
      ours_sha: 'b'.repeat(40),
    };
    const body = new URLSearchParams(payload).toString();
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);

    const form = await readLimitedFormData(post(body, URLENCODED), CAP);
    expect([...form.keys()]).toEqual(Object.keys(payload));
    expect(form.get('ops')).toBe(ops);
  });

  it('does not count multipart parts', async () => {
    const parts = Array.from(
      { length: 10_001 },
      (_, n) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f${n}"\r\n\r\nx&y\r\n`
    );
    const body = `${parts.join('')}--${BOUNDARY}--\r\n`;
    const form = await readLimitedFormData(
      post(body, `multipart/form-data; boundary=${BOUNDARY}`),
      CAP
    );
    expect([...form.keys()]).toHaveLength(10_001);
  });
});

describe('the form type', () => {
  it('is the media type before any parameter, compared exactly', () => {
    const { formMediaType } = limits;
    expect(formMediaType('multipart/form-data; boundary=x')).toBe('multipart/form-data');
    expect(formMediaType('MULTIPART/Form-Data ;boundary=x')).toBe('multipart/form-data');
    expect(formMediaType('application/x-www-form-urlencoded;charset=UTF-8')).toBe(URLENCODED);
    expect(formMediaType('application/x-www-form-urlencoded; x=multipart/form-data')).toBe(
      URLENCODED
    );
    expect(formMediaType('multipart/form-data, application/x-www-form-urlencoded')).toBeNull();
    expect(formMediaType('multipart/form-datax; boundary=x')).toBeNull();
    expect(formMediaType('text/plain')).toBeNull();
    expect(formMediaType(null)).toBeNull();
  });

  for (const contentType of [
    'multipart/form-data; boundary=b, application/x-www-form-urlencoded',
    'multipart/form-data, application/x-www-form-urlencoded',
  ]) {
    it(`does not parse a body sent as ${JSON.stringify(contentType)}`, async () => {
      await expect(readLimitedFormData(post('a=1&b=2', contentType), CAP)).rejects.toThrow(
        TypeError
      );
    });
  }

  it('still reads a multipart body sent with its boundary', async () => {
    const body = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="intent"\r\n\r\nupload\r\n--${BOUNDARY}--\r\n`;
    const form = await readLimitedFormData(
      post(body, `multipart/form-data; boundary=${BOUNDARY}`),
      CAP
    );
    expect(form.get('intent')).toBe('upload');
  });
});
