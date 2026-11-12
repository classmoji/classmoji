import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ID_LIST_MAX_BYTES,
  UploadTooLargeError,
  parseJsonWithin,
  textOverBytes,
} from '../uploadLimit.ts';
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

describe('the id list cap', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('holds a choice for every block a page op may replace, many times over', () => {
    // Merge choices as the chooser posts them, one per conflicting block or slide.
    const choices = Array.from({ length: 8_000 }, (_, n) => ({ id: uuid(n), choose: 'theirs' }));
    const text = JSON.stringify(choices);
    expect(parseJsonWithin(text, ID_LIST_MAX_BYTES)).toHaveLength(8_000);
  });

  it('holds a thousand image paths of 500 bytes', () => {
    const paths = Array.from(
      { length: 1_000 },
      (_, n) => `slides/deck/images/${String(n).padStart(4, '0')}-${'x'.repeat(472)}.png`
    );
    expect(paths.every(path => utf8(path) === 500)).toBe(true);
    expect(parseJsonWithin(JSON.stringify(paths), ID_LIST_MAX_BYTES)).toHaveLength(1_000);
  });

  it('refuses a list one byte over it before parsing it', () => {
    const text = JSON.stringify(['x'.repeat(ID_LIST_MAX_BYTES - 3)]);
    expect(utf8(text)).toBe(ID_LIST_MAX_BYTES + 1);
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseJsonWithin(text, ID_LIST_MAX_BYTES)).toThrow(UploadTooLargeError);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
