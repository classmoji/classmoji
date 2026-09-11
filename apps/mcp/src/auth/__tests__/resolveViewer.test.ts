/**
 * Unit tests for resolveViewer — the single token-validation seam (plan §3.2).
 *
 * better-auth's getMcpSession is mocked (vi.mock factory idiom, per
 * packages/services/__tests__) because the two behaviors under test are OURS,
 * layered on top of it:
 *   1. expiry enforcement — better-auth 1.4.18 getMcpSession returns the raw
 *      oauth_access_tokens row WITHOUT checking accessTokenExpiresAt, so
 *      resolveViewer must reject expired rows itself;
 *   2. scope parsing — the row stores scopes as a space-delimited string;
 *   3. the `oauth_applications.disabled` kill switch (finding 16) — getMcpSession
 *      returns the TOKEN row only and never looks at the owning application, so
 *      disabling a client would revoke nothing unless resolveViewer checks it.
 *      Prisma is mocked for the same reason better-auth is: the behaviour under
 *      test is ours.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../../mcp/errors.ts';

const getMcpSession = vi.fn();
const findUniqueApplication = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  auth: { api: { getMcpSession: (...args: unknown[]) => getMcpSession(...args) } },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    oauthApplication: { findUnique: (...args: unknown[]) => findUniqueApplication(...args) },
  }),
}));

const { resolveViewer } = await import('../resolveViewer.ts');

const HEADERS = new Headers({ authorization: 'Bearer whatever' });

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    clientId: 'client-1',
    scopes: 'openid read write',
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  getMcpSession.mockReset();
  findUniqueApplication.mockReset();
  // Default: the token's OAuth application exists and is enabled.
  findUniqueApplication.mockResolvedValue({ disabled: false });
});

describe('resolveViewer', () => {
  it('resolves a valid token to a Viewer with parsed scopes', async () => {
    getMcpSession.mockResolvedValue(validRow());

    const viewer = await resolveViewer(HEADERS);

    expect(viewer.userId).toBe('user-1');
    expect(viewer.clientId).toBe('client-1');
    // 'openid read write' (space-delimited string) → Set
    expect(viewer.scopes).toBeInstanceOf(Set);
    expect([...viewer.scopes].sort()).toEqual(['openid', 'read', 'write']);
  });

  it('passes the headers through to getMcpSession', async () => {
    getMcpSession.mockResolvedValue(validRow());
    await resolveViewer(HEADERS);
    expect(getMcpSession).toHaveBeenCalledWith({ headers: HEADERS });
  });

  it('rejects a token past accessTokenExpiresAt (expiry enforced HERE, not in better-auth)', async () => {
    getMcpSession.mockResolvedValue(
      validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    );

    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/expired/i);
  });

  it('rejects a token expiring exactly now (boundary is exclusive)', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: new Date(now) }));
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a row with no expiry at all (fail closed)', async () => {
    getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: null }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a row with an unparseable expiry (fail closed)', async () => {
    getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: 'not-a-date' }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
  });

  it('accepts an ISO-string expiry in the future (driver may return strings)', async () => {
    getMcpSession.mockResolvedValue(
      validRow({ accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    );
    const viewer = await resolveViewer(HEADERS);
    expect(viewer.userId).toBe('user-1');
  });

  it('rejects when no session is found (missing/unknown token)', async () => {
    getMcpSession.mockResolvedValue(null);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/missing or invalid/i);
  });

  it('maps a thrown better-auth APIError (garbage token / malformed header) to UnauthorizedError', async () => {
    getMcpSession.mockRejectedValue(new Error('APIError: bad request'));
    await expect(resolveViewer(new Headers({ authorization: 'garbage' }))).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('rejects a row not bound to a user', async () => {
    getMcpSession.mockResolvedValue(validRow({ userId: null }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/not bound to a user/i);
  });

  it('normalizes missing scopes to an empty set (never grants by default)', async () => {
    getMcpSession.mockResolvedValue(validRow({ scopes: null }));
    const viewer = await resolveViewer(HEADERS);
    expect(viewer.scopes.size).toBe(0);
  });

  it('collapses extra whitespace in the scope string', async () => {
    getMcpSession.mockResolvedValue(validRow({ scopes: '  read   write  ' }));
    const viewer = await resolveViewer(HEADERS);
    expect([...viewer.scopes].sort()).toEqual(['read', 'write']);
  });

  it('rejects a row with no client id (fail closed — the kill switch keys on it)', async () => {
    getMcpSession.mockResolvedValue(validRow({ clientId: undefined }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/not bound to an oauth client/i);
  });

  describe('oauth_applications.disabled kill switch (finding 16)', () => {
    it('REFUSES a token whose OAuth application is disabled', async () => {
      getMcpSession.mockResolvedValue(validRow());
      findUniqueApplication.mockResolvedValue({ disabled: true });

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
      await expect(resolveViewer(HEADERS)).rejects.toThrow(/client is disabled/i);
    });

    it('looks the application up by the client id on the token row itself', async () => {
      getMcpSession.mockResolvedValue(validRow({ clientId: 'classmoji-ask-moji' }));

      await resolveViewer(HEADERS);

      expect(findUniqueApplication).toHaveBeenCalledWith({
        where: { clientId: 'classmoji-ask-moji' },
        select: { disabled: true },
      });
    });

    it('refuses a token whose application row has vanished', async () => {
      getMcpSession.mockResolvedValue(validRow());
      findUniqueApplication.mockResolvedValue(null);

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    });

    it('accepts a nullish `disabled` (the column is Boolean? defaulting to false)', async () => {
      getMcpSession.mockResolvedValue(validRow());
      findUniqueApplication.mockResolvedValue({ disabled: null });

      const viewer = await resolveViewer(HEADERS);
      expect(viewer.userId).toBe('user-1');
    });

    it('does not reach the application lookup for an already-expired token', async () => {
      getMcpSession.mockResolvedValue(
        validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
      expect(findUniqueApplication).not.toHaveBeenCalled();
    });
  });
});
