/**
 * `sanitizeFormsSplat` — the one piece of the forms deep-link redirect that is
 * pure, and the one that would be a security bug if it were wrong.
 *
 * The splat is user-controlled URL text that is concatenated onto a configured
 * origin. Two shapes matter:
 *
 *  - `..` segments would climb out of the forms subtree, so
 *    `/admin/cs52/forms/../../evil` would leave the redirect pointing at a path
 *    nobody authorized.
 *  - a LEADING EMPTY segment would produce `//host`, a protocol-relative URL —
 *    an open redirect to somebody else's origin, which is the reason this
 *    function exists rather than a bare template string.
 *
 * Everything else is ordinary URL hygiene: the segments that survive are
 * percent-encoded, so a slug cannot smuggle a query or a fragment into the
 * redirect target.
 */

import { describe, expect, it, vi } from 'vitest';

// The module is a route: it imports the gate and react-router at load time, and
// neither has anything to do with the function under test.
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
}));
vi.mock('react-router', () => ({ redirect: vi.fn() }));

const { sanitizeFormsSplat } = await import('../admin.$class.forms_.$/route.tsx');

describe('sanitizeFormsSplat', () => {
  it('passes an ordinary deep link through unchanged', () => {
    expect(sanitizeFormsSplat('new')).toBe('new');
    expect(sanitizeFormsSplat('spring-waitlist/edit')).toBe('spring-waitlist/edit');
    expect(sanitizeFormsSplat('spring-waitlist/responses')).toBe('spring-waitlist/responses');
  });

  it('treats a missing or empty splat as the subtree root', () => {
    // This is the bare `/admin/:class/forms/` case, which the caller turns into
    // the collection URL rather than one with a trailing slash.
    expect(sanitizeFormsSplat(undefined)).toBe('');
    expect(sanitizeFormsSplat('')).toBe('');
    expect(sanitizeFormsSplat('/')).toBe('');
  });

  it('drops `..` and `.` so a link cannot climb out of the forms subtree', () => {
    expect(sanitizeFormsSplat('../../evil')).toBe('evil');
    expect(sanitizeFormsSplat('spring-waitlist/../../../etc/passwd')).toBe(
      'spring-waitlist/etc/passwd'
    );
    expect(sanitizeFormsSplat('./edit')).toBe('edit');
    expect(sanitizeFormsSplat('..')).toBe('');
  });

  it('drops empty segments, which is what stops a protocol-relative open redirect', () => {
    // `//evil.example` appended to an origin is a URL on evil.example, not a
    // path on ours. Collapsing the empty segment is what prevents it.
    expect(sanitizeFormsSplat('/evil.example')).toBe('evil.example');
    expect(sanitizeFormsSplat('//evil.example')).toBe('evil.example');
    expect(sanitizeFormsSplat('///evil.example/path')).toBe('evil.example/path');
  });

  it('percent-encodes each surviving segment, so a slug cannot smuggle a URL part', () => {
    expect(sanitizeFormsSplat('a b')).toBe('a%20b');
    expect(sanitizeFormsSplat('slug?next=evil')).toBe('slug%3Fnext%3Devil');
    expect(sanitizeFormsSplat('slug#frag')).toBe('slug%23frag');
    // An absolute URL is not a special case — it is just segments, and its
    // scheme's colon is encoded like anything else.
    expect(sanitizeFormsSplat('https://evil.example/x')).toBe('https%3A/evil.example/x');
  });

  it('never returns a value that starts with a slash', () => {
    for (const input of ['//x', '/', '///', '/../y', '..//..//z']) {
      expect(sanitizeFormsSplat(input).startsWith('/')).toBe(false);
    }
  });
});
