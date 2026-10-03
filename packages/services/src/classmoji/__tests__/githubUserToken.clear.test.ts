/**
 * clearRevokedTokenForUser: with the refused token named, only a stored token
 * that is still that one is cleared, so a token refreshed in the meantime
 * survives. Without it, every stored Github token of the user is cleared.
 *
 * Tokens are stored encrypted (random IV), so the comparison happens in code
 * on the decrypted value, never in the query; the write is conditioned on the
 * expiry so a refresh landing in between still wins.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateMany: vi.fn(), findMany: vi.fn() }));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    account: {
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      findMany: (...a: unknown[]) => mocks.findMany(...a),
    },
  }),
}));

const { clearRevokedTokenForUser } = await import('../githubUserToken.service.ts');

const EXPIRES = new Date('2026-01-01T00:00:00Z');

beforeEach(() => {
  mocks.updateMany.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValue([
    { id: 'acc-1', access_token: 'ghu_refused', access_token_expires_at: EXPIRES },
  ]);
});

describe('clearRevokedTokenForUser', () => {
  it('clears the named token, conditioned on its expiry, never filtering on the token', async () => {
    await clearRevokedTokenForUser('user-1', 'ghu_refused');

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1', provider_id: 'github' } })
    );
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-1', access_token_expires_at: EXPIRES },
      data: { access_token: null, access_token_expires_at: new Date(0) },
    });
  });

  it('leaves a token refreshed in the meantime alone', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'acc-1', access_token: 'ghu_new', access_token_expires_at: EXPIRES },
    ]);
    await clearRevokedTokenForUser('user-1', 'ghu_refused');
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('clears the stored token unconditionally when none is named', async () => {
    await clearRevokedTokenForUser('user-1');

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-1', access_token_expires_at: EXPIRES },
      data: { access_token: null, access_token_expires_at: new Date(0) },
    });
  });
});
