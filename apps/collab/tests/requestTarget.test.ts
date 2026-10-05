import { describe, expect, it } from 'vitest';

import { parseRequestTarget } from '../src/http.ts';

describe('parseRequestTarget', () => {
  it('reads path and query from an ordinary target', () => {
    const { pathname, searchParams } = parseRequestTarget('/internal/page/abc/snapshot?viewer=u1');
    expect(pathname).toBe('/internal/page/abc/snapshot');
    expect(searchParams.get('viewer')).toBe('u1');
  });

  it('never throws on targets new URL(raw, base) rejects', () => {
    for (const raw of ['//%2e%2e%2f%2eenv', '//', '//..', '//[::1', '/\\\\evil', '//%zz']) {
      expect(() => parseRequestTarget(raw)).not.toThrow();
    }
    expect(parseRequestTarget('//%2e%2e%2f%2eenv').pathname).toBe('//%2e%2e%2f%2eenv');
  });

  it('treats a missing or non-path target as /', () => {
    expect(parseRequestTarget(undefined).pathname).toBe('/');
    expect(parseRequestTarget('http://x/y').pathname).toBe('/');
    expect(parseRequestTarget('*').pathname).toBe('/');
  });
});
