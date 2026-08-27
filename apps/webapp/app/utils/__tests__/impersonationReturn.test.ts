/**
 * Unit tests for the impersonation return path.
 *
 * "Stop viewing" used to rebuild an `/admin/<slug>/...` URL by parsing a class
 * slug out of whatever page the impersonated session had reached. That guessed
 * at both the classroom and the actor's role in it: an impersonated session can
 * move between classrooms, and `/admin/:class/**` is closed to non-owner
 * navigation, so the guess could land the actor on a 403 the instant their
 * elevated session ended.
 *
 * Recording the origin on the way IN removes the guess — the page the actor was
 * standing on when they clicked "View as" is one they could open a moment
 * earlier. These tests pin that the recorded value round-trips, is consumed
 * once, and that nothing off-origin can be smuggled through the store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

const sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

vi.stubGlobal('window', {
  sessionStorage,
  location: { pathname: '/admin/cs52-26f/students' },
});

const { rememberImpersonationReturn, takeImpersonationReturn, clearImpersonationReturn } =
  await import('../impersonationReturn.ts');

const KEY = 'cm_impersonation_return';

beforeEach(() => {
  store.clear();
});

describe('rememberImpersonationReturn', () => {
  it('defaults to the page the caller is standing on', () => {
    rememberImpersonationReturn();

    expect(store.get(KEY)).toBe('/admin/cs52-26f/students');
  });

  it('records an explicitly named path', () => {
    rememberImpersonationReturn('/admin/cs52-26f/staff/ada');

    expect(store.get(KEY)).toBe('/admin/cs52-26f/staff/ada');
  });

  it.each([
    ['//evil.example/admin', 'protocol-relative — a valid pathname prefix, an off-origin target'],
    ['https://evil.example/admin', 'absolute URL'],
    ['admin/cs52-26f/students', 'relative path'],
  ])('refuses to record %s (%s)', path => {
    rememberImpersonationReturn(path);

    expect(store.has(KEY)).toBe(false);
  });
});

describe('takeImpersonationReturn', () => {
  it('returns the recorded path and consumes it', () => {
    rememberImpersonationReturn('/admin/cs52-26f/staff');

    expect(takeImpersonationReturn()).toBe('/admin/cs52-26f/staff');
    // Consumed: a later stop in the same tab must not reuse a stale origin.
    expect(takeImpersonationReturn()).toBeNull();
  });

  it('returns null in a tab that never started an impersonation', () => {
    // Which is what sends the banner to the classroom picker — always
    // reachable, and never a 403.
    expect(takeImpersonationReturn()).toBeNull();
  });

  it('refuses a stored value that is not a same-document path', () => {
    // Belt and braces: the setter already rejects these, so reaching this
    // branch means the store was written by something other than the setter.
    store.set(KEY, '//evil.example/admin');

    expect(takeImpersonationReturn()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });
});

describe('clearImpersonationReturn', () => {
  it('drops the recorded origin without returning it', () => {
    // The admin-app return path navigates off-origin instead, so it must not
    // leave a record behind for the next impersonation in this tab.
    rememberImpersonationReturn('/admin/cs52-26f/students');

    clearImpersonationReturn();

    expect(takeImpersonationReturn()).toBeNull();
  });
});
