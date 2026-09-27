import { describe, it, expect } from 'vitest';
import {
  FileRefusedError,
  sanitizeFilename,
  uploadRefusalStatus,
  validateFile,
} from '../utils/validateFile.ts';
import { RepoFileTooLargeError } from '../repoLimits.ts';

const NEEDS_EXTENSION = 'This file needs an extension, e.g. notes.txt';

describe('validateFile — names under the two type policies', () => {
  it.each(['Makefile', '.gitignore', 'README', 'x.データ', '.png'])(
    "refuses %s under 'any': it keeps no extension once sanitized",
    filename => {
      expect(validateFile({ filename, size: 10, fileTypes: 'any' })).toEqual({
        valid: false,
        error: NEEDS_EXTENSION,
        reason: 'extension',
      });
      // …and agrees with what would have been stored.
      expect(sanitizeFilename(filename)).not.toMatch(/\.[a-z0-9]+$/);
    }
  );

  it.each(['notes.txt', 'Notebook.IPYNB', 'lecture.tar.gz'])("accepts %s under 'any'", filename => {
    expect(validateFile({ filename, size: 10, fileTypes: 'any' })).toEqual({ valid: true });
  });

  it("accepts an 8-character extension under 'any' — the longest the signer will sign", () => {
    expect(validateFile({ filename: 'notes.abcdefgh', size: 10, fileTypes: 'any' })).toEqual({
      valid: true,
    });
  });

  it("refuses a 9-character extension under 'any': it would commit but never be servable", () => {
    expect(validateFile({ filename: 'notes.abcdefghi', size: 10, fileTypes: 'any' })).toEqual({
      valid: false,
      error: 'File extensions can be at most 8 letters or digits (.abcdefghi is 9).',
      reason: 'extension',
    });
  });

  it("reports the extension's real length, not the sanitizer's 16-character cap", () => {
    expect(
      validateFile({ filename: 'notes.abcdefghijklmnopqrst', size: 10, fileTypes: 'any' })
    ).toEqual({
      valid: false,
      error: 'File extensions can be at most 8 letters or digits (.abcdefghijklmnop… is 20).',
      reason: 'extension',
    });
  });

  it("leaves 'allowlist' refusals as they were", () => {
    for (const filename of ['Makefile', '.gitignore', 'README', 'x.データ', 'notes.txt']) {
      const result = validateFile({ filename, size: 10 });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/^Invalid file type\. Allowed: /);
    }
    expect(validateFile({ filename: 'diagram.PNG', size: 10 })).toEqual({ valid: true });
  });

  it('checks separators and empty names before the extension, under either policy', () => {
    expect(validateFile({ filename: 'a/b.txt', size: 1, fileTypes: 'any' }).error).toBe(
      'File names cannot contain "/" or "\\".'
    );
    expect(validateFile({ filename: '...', size: 1, fileTypes: 'any' }).error).toBe(
      'That file needs a name.'
    );
  });
});

describe('validateFile — why a file was refused', () => {
  it.each([
    ['script.py', 'allowlist', 'type'],
    ['Makefile', 'allowlist', 'type'],
    ['Makefile', 'any', 'extension'],
    ['notes.abcdefghi', 'any', 'extension'],
    ['a/b.png', 'allowlist', 'name'],
    ['a\\b.txt', 'any', 'name'],
    ['...', 'any', 'name'],
    ['  ', 'allowlist', 'name'],
  ] as const)('%s under %s is refused for its %s', (filename, fileTypes, reason) => {
    expect(validateFile({ filename, size: 1, fileTypes }).reason).toBe(reason);
  });

  it("calls a file over the repository's cap too large, whatever its name", () => {
    expect(validateFile({ filename: 'script.py', size: 36 * 1024 * 1024 }).reason).toBe(
      'too_large'
    );
  });
});

describe('upload refusals as HTTP statuses', () => {
  it('answers 415 for a type or an extension, 400 for a name', () => {
    expect(new FileRefusedError('no', 'type').status).toBe(415);
    expect(new FileRefusedError('no', 'extension').status).toBe(415);
    expect(new FileRefusedError('no', 'name').status).toBe(400);
  });

  it('maps every refusal once — and nothing else', () => {
    expect(uploadRefusalStatus(new FileRefusedError('no', 'type'))).toBe(415);
    expect(uploadRefusalStatus(new FileRefusedError('no', 'extension'))).toBe(415);
    expect(uploadRefusalStatus(new FileRefusedError('no', 'name'))).toBe(400);
    expect(uploadRefusalStatus(new RepoFileTooLargeError('big.pdf'))).toBe(413);

    // A fault is not a refusal, even one whose message reads like one.
    expect(uploadRefusalStatus(new Error('Invalid file type. Allowed: .png'))).toBeNull();
    expect(uploadRefusalStatus(Object.assign(new Error('x'), { status: 415 }))).toBeNull();
    expect(uploadRefusalStatus(null)).toBeNull();
    expect(uploadRefusalStatus('FILE_REFUSED')).toBeNull();
  });

  it('recognises a refusal that crossed a boundary as a plain object', () => {
    expect(uploadRefusalStatus({ code: 'FILE_REFUSED', status: 400 })).toBe(400);
    expect(uploadRefusalStatus({ code: 'FILE_REFUSED', status: 415 })).toBe(415);
  });
});
