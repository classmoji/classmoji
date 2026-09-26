/**
 * The upload-slot module lives as three identical copies — slides, pages and
 * webapp — until it moves into a server-only `@classmoji/utils` subpath. Only
 * the header comment may differ; the code must not drift.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const code = (relative: string) => {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  // Everything after the header comment.
  return text.slice(text.indexOf('*/') + 2).trim();
};

describe('uploadConcurrency.server copies', () => {
  it('carry the same code as the slides original', () => {
    const slides = code('../../../../slides/app/utils/uploadConcurrency.server.ts');
    expect(code('../uploadConcurrency.server.ts')).toBe(slides);
    expect(code('../../../../pages/app/utils/uploadConcurrency.server.ts')).toBe(slides);
  });
});
