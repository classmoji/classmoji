import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeForExtension,
  contentTypeForPath,
  extensionOf,
  isRasterExtension,
} from '../src/content-type.ts';

describe('content type mapping', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['svg', 'image/svg+xml'],
    ['html', 'text/html; charset=utf-8'],
    ['htm', 'text/html; charset=utf-8'],
    ['css', 'text/css; charset=utf-8'],
    ['js', 'text/javascript; charset=utf-8'],
    ['mjs', 'text/javascript; charset=utf-8'],
    ['woff', 'font/woff'],
    ['woff2', 'font/woff2'],
    ['ttf', 'font/ttf'],
    ['otf', 'font/otf'],
    ['mp4', 'video/mp4'],
    ['webm', 'video/webm'],
    ['pdf', 'application/pdf'],
    ['json', 'application/json; charset=utf-8'],
    ['txt', 'text/plain; charset=utf-8'],
    ['md', 'text/markdown; charset=utf-8'],
  ])('maps %s', (ext, expected) => {
    expect(contentTypeForExtension(ext)).toBe(expected);
  });

  it('falls back to an opaque type for anything unmapped', () => {
    expect(contentTypeForExtension('exe')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForExtension('')).toBe(DEFAULT_CONTENT_TYPE);
  });

  it('is case-insensitive', () => {
    expect(contentTypeForExtension('PNG')).toBe('image/png');
  });

  it('gives every text type an explicit charset', () => {
    // Without one a browser falls back to its own locale default, and a deck's
    // smart quotes come out as mojibake on machines nobody tests on.
    for (const ext of ['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md']) {
      expect(contentTypeForExtension(ext)).toMatch(/; charset=utf-8$/);
    }
  });
});

describe('extensionOf', () => {
  it('reads the last extension of a nested path', () => {
    expect(extensionOf('css/site.min.css')).toBe('css');
  });

  it('returns empty for dotfiles and extensionless names', () => {
    expect(extensionOf('LICENSE')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('dir.with.dots/file')).toBe('');
  });

  it('drives the theme content type', () => {
    expect(contentTypeForPath('fonts/inter.woff2')).toBe('font/woff2');
  });
});

describe('isRasterExtension', () => {
  it('only allows formats Images can decode', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif']) {
      expect(isRasterExtension(ext)).toBe(true);
    }
    // svg is in this list on purpose: it IS an image, but a
    // resolution-independent one, so rasterizing it to a `w=` rung is a
    // downgrade rather than a variant. Text never reaches a transform at all.
    for (const ext of ['svg', 'pdf', 'css', 'mp4', 'html', 'json', 'md', 'woff2']) {
      expect(isRasterExtension(ext)).toBe(false);
    }
  });
});
