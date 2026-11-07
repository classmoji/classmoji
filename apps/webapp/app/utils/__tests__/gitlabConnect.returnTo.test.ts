/**
 * Where "Connect GitLab" lands afterwards: a path on this app, else the
 * GitLab classroom setup. The rule itself is `@classmoji/utils/return-path`'s
 * (tested there); this pins that the connect flow uses it with its fallback.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/auth/server', () => ({ AUTH_SECRET: 'test-secret' }));

const { safeReturnTo } = await import('../gitlabConnect.server');

const FALLBACK = '/create-classroom?provider=gitlab';

describe('safeReturnTo', () => {
  it('keeps a path on this app, with its query and hash', () => {
    expect(safeReturnTo('/create-classroom?provider=gitlab&step=2#org')).toBe(
      '/create-classroom?provider=gitlab&step=2#org'
    );
    expect(safeReturnTo('/settings')).toBe('/settings');
  });

  it.each([
    null,
    '',
    '//host.example',
    '/\\host.example',
    '\\\\host.example',
    'https://host.example',
  ])('falls back for %j', value => {
    expect(safeReturnTo(value)).toBe(FALLBACK);
  });
});
