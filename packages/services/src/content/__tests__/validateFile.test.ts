import { describe, it, expect } from 'vitest';
import { sanitizeFilename, validateFile } from '../utils/validateFile.ts';

const NEEDS_EXTENSION = 'This file needs an extension, e.g. notes.txt';

describe('validateFile — names under the two type policies', () => {
  it.each(['Makefile', '.gitignore', 'README', 'x.データ', '.png'])(
    "refuses %s under 'any': it keeps no extension once sanitized",
    filename => {
      expect(validateFile({ filename, size: 10, fileTypes: 'any' })).toEqual({
        valid: false,
        error: NEEDS_EXTENSION,
      });
      // …and agrees with what would have been stored.
      expect(sanitizeFilename(filename)).not.toMatch(/\.[a-z0-9]+$/);
    }
  );

  it.each(['notes.txt', 'Notebook.IPYNB', 'lecture.tar.gz'])("accepts %s under 'any'", filename => {
    expect(validateFile({ filename, size: 10, fileTypes: 'any' })).toEqual({ valid: true });
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
