import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadTooLargeError, parseJsonWithin, textOverBytes } from '../uploadLimit.ts';
import { DOCUMENT_SAVE_MAX_BYTES, DOCUMENT_SAVE_MAX_LABEL } from '../repoLimits.ts';

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

describe('textOverBytes', () => {
  it('counts UTF-8 bytes, as TextEncoder does', () => {
    // ASCII, two-, three- and four-byte characters, and lone surrogates
    // (encoded as U+FFFD, three bytes).
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀é€z', '\ud800', 'x\udc00y']) {
      expect(textOverBytes(text, utf8(text))).toBe(false);
      if (utf8(text) > 0) expect(textOverBytes(text, utf8(text) - 1)).toBe(true);
    }
  });

  it('decides from the length when the length settles it', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(textOverBytes('a'.repeat(11), 10)).toBe(true);
    expect(textOverBytes('€'.repeat(3), 9)).toBe(false);
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });
});

describe('parseJsonWithin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses text of exactly the limit', () => {
    const text = JSON.stringify(['x'.repeat(100)]);
    expect(parseJsonWithin(text, utf8(text))).toEqual(['x'.repeat(100)]);
  });

  it('refuses text one byte over the limit without parsing it', () => {
    const text = `[${'{},'.repeat(1_000)}{}]`;
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseJsonWithin(text, utf8(text) - 1)).toThrow(UploadTooLargeError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('counts a multi-byte character by its bytes', () => {
    // Three UTF-16 units, four bytes.
    expect(() => parseJsonWithin('"é"', 3)).toThrow(UploadTooLargeError);
    expect(parseJsonWithin('"é"', 4)).toBe('é');
  });

  it('carries the limit and a 413', () => {
    try {
      parseJsonWithin('[1,2,3]', 3);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UploadTooLargeError);
      expect((error as UploadTooLargeError).limitBytes).toBe(3);
      expect((error as UploadTooLargeError).status).toBe(413);
    }
  });

  it('leaves text that is not JSON to the parser', () => {
    expect(() => parseJsonWithin('{', 10)).toThrow(SyntaxError);
  });
});

describe('the document save cap', () => {
  it('is 4 MB', () => {
    expect(DOCUMENT_SAVE_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(DOCUMENT_SAVE_MAX_LABEL).toBe('4 MB');
  });
});
