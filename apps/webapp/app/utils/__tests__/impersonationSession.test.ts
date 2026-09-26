import { describe, expect, it } from 'vitest';
import { isImpersonatingSession } from '../impersonationSession';

describe('isImpersonatingSession', () => {
  it('is true when the session records who is viewing as this user', () => {
    expect(
      isImpersonatingSession({
        userId: 'u-1',
        token: 't',
        session: { session: { impersonatedBy: 'admin-1' } },
      })
    ).toBe(true);
  });

  it('is false for an ordinary session, a missing session, or no auth data', () => {
    expect(isImpersonatingSession({ userId: 'u-1', session: { session: {} } })).toBe(false);
    expect(
      isImpersonatingSession({ userId: 'u-1', session: { session: { impersonatedBy: null } } })
    ).toBe(false);
    expect(isImpersonatingSession({ userId: 'u-1' })).toBe(false);
    expect(isImpersonatingSession(null)).toBe(false);
    expect(isImpersonatingSession(undefined)).toBe(false);
  });
});
