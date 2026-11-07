import { describe, expect, it } from 'vitest';
import { isSafeReturnPath, safeReturnPath } from '../returnPath.ts';

const FALLBACK = '/fallback';

const ACCEPTED = [
  '/',
  '/select-organization',
  '/admin/cs52/assignments/12',
  '/create-classroom?provider=gitlab',
  '/admin/cs52/grades?view=letters#row-4',
  '/search?q=a b',
  '/caf%C3%A9',
  '/a/b//c',
  '/a/../b',
  '/./a',
];

describe('isSafeReturnPath', () => {
  it.each(ACCEPTED)('accepts the same-origin path %j', value => {
    expect(isSafeReturnPath(value)).toBe(true);
    expect(safeReturnPath(value, FALLBACK)).toBe(value);
  });

  it.each([
    ['protocol-relative', '//host.example/path'],
    ['slash then backslash', '/\\host.example'],
    ['two backslashes', '\\\\host.example'],
    ['a backslash later in the path', '/admin\\..\\x'],
    ['an absolute https URL', 'https://host.example/'],
    ['an absolute http URL', 'http://x/path'],
    ['a javascript: URL', 'javascript:void(0)'],
    ['a data: URL', 'data:text/html,hi'],
    ['a relative path', 'admin/cs52'],
    ['a dot path', './admin'],
    ['a leading space', ' /admin'],
    ['a tab after the slash', '/\t/host.example'],
    ['a newline', '/admin\nx'],
    ['a carriage return', '/admin\r\nx'],
    ['a NUL', '/admin\u0000'],
    ['DEL', '/admin\u007f'],
    ['a C1 control', '/admin\u0085'],
    ['a Latin-1 letter', '/caf\u00e9'],
    ['a fullwidth slash', '/\uff0fhost.example'],
    ['a no-break space', '/\u00a0x'],
    ['an emoji', '/\u{1f600}'],
    ['a parent segment resolving to //', '/..//host.example'],
    ['a current segment resolving to //', '/.//host.example'],
    ['an encoded parent segment resolving to //', '/%2e%2e//host.example'],
    ['an upper-case encoded parent segment resolving to //', '/%2E%2E//host.example'],
    ['an encoded current segment resolving to //', '/%2e//host.example'],
    ['a deeper parent segment resolving to //', '/a/..//host.example'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isSafeReturnPath(value)).toBe(false);
    expect(safeReturnPath(value, FALLBACK)).toBe(FALLBACK);
  });

  it.each([null, undefined, 42, {}, ['/admin']])('rejects the non-string %j', value => {
    expect(isSafeReturnPath(value)).toBe(false);
    expect(safeReturnPath(value, FALLBACK)).toBe(FALLBACK);
  });

  // Percent-encoding is not decoded before the origin is decided, so an
  // encoded backslash or slash stays part of a path on this origin.
  it.each([
    ['/%5Chost.example', '/%5Chost.example'],
    ['/%5C%5Chost.example', '/%5C%5Chost.example'],
    ['/%2F%2Fhost.example', '/%2F%2Fhost.example'],
    ['/%2Fhost.example', '/%2Fhost.example'],
  ])('keeps the encoded path %j on this origin', (value, pathname) => {
    const resolved = new URL(value, 'https://app.example');
    expect(resolved.origin).toBe('https://app.example');
    expect(resolved.pathname).toBe(pathname);
    expect(isSafeReturnPath(value)).toBe(true);
  });

  it('rejects an encoded value whose decoded form is not a path', () => {
    // `?next=%2F%2Fhost` arrives decoded from URLSearchParams.
    const next = new URLSearchParams('next=%2F%2Fhost.example').get('next');
    expect(next).toBe('//host.example');
    expect(isSafeReturnPath(next)).toBe(false);
    const back = new URLSearchParams('next=%2F%5Chost.example').get('next');
    expect(back).toBe('/\\host.example');
    expect(isSafeReturnPath(back)).toBe(false);
  });

  /**
   * Every value it accepts stays a path on this origin however it is passed
   * on: as given, resolved against a base, or rebuilt from the resolved
   * pathname and search (what a redirect that appends a query param does).
   */
  it('accepts nothing that resolves to another origin or a path beginning with //', () => {
    const pieces = [
      '/',
      '//',
      '\\',
      '.',
      '..',
      '%2e',
      '%2E',
      '%2e%2e',
      '.%2E',
      '%2f',
      '%2F',
      '%5c',
      '%5C',
      '?',
      '#',
      ';',
      '@',
      'h',
      ' ',
    ];
    let accepted = 0;
    const check = (value: string) => {
      if (!isSafeReturnPath(value)) return;
      accepted += 1;
      const resolved = new URL(value, 'https://app.example');
      expect(resolved.origin, value).toBe('https://app.example');
      expect(resolved.pathname.startsWith('//'), value).toBe(false);
      const rebuilt = `${resolved.pathname}${resolved.search}`;
      expect(new URL(rebuilt, 'https://app.example').origin, value).toBe('https://app.example');
      expect(isSafeReturnPath(rebuilt), value).toBe(true);
    };
    // Every string of up to five pieces, checked as it is built.
    const walk = (prefix: string, depth: number) => {
      if (depth === 0) return;
      for (const piece of pieces) {
        const value = prefix + piece;
        check(value);
        walk(value, depth - 1);
      }
    };
    ACCEPTED.forEach(check);
    walk('', 5);

    // The search space holds plenty of accepted values, not just rejections.
    expect(accepted).toBeGreaterThan(1000);
    // About 2.6 million strings: seconds, not the default five.
  }, 60_000);
});

describe('safeReturnPath', () => {
  it('returns the fallback as given, including null', () => {
    expect(safeReturnPath('//host.example', null)).toBeNull();
    expect(safeReturnPath('/ok', null)).toBe('/ok');
  });
});
