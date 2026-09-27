/**
 * clearRevokedTokenForUser: with the refused token named, only a stored token
 * that is still that one is cleared, so a token refreshed in the meantime
 * survives. Without it, the behaviour existing callers rely on is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock('@classmoji/database', () => ({
  default: () => ({ account: { updateMany: (...a: unknown[]) => mocks.updateMany(...a) } }),
}));

const { clearRevokedTokenForUser } = await import('../githubUserToken.service.ts');

beforeEach(() => {
  mocks.updateMany.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe('clearRevokedTokenForUser', () => {
  it('clears only the named token when one is given', async () => {
    await clearRevokedTokenForUser('user-1', 'ghu_refused');

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', provider_id: 'github', access_token: 'ghu_refused' },
      data: { access_token: null, access_token_expires_at: new Date(0) },
    });
  });

  it('clears the stored token unconditionally when none is named', async () => {
    await clearRevokedTokenForUser('user-1');

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', provider_id: 'github' },
      data: { access_token: null, access_token_expires_at: new Date(0) },
    });
  });
});
