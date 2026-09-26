/**
 * Sign-in profile mapping. `User.login` is unique across providers, so the
 * rules pinned here are what keep one provider's username from ever resolving
 * to another provider's user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mapGitHubProfile,
  mapGitLabProfile,
  onAccountCreated,
  promoteGitHubLogin,
} from '../providerProfile.ts';

const prisma = {
  user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  account: { upsert: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
};
const db = prisma as unknown as Parameters<typeof mapGitHubProfile>[0];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('mapGitHubProfile', () => {
  it('only matches a login held by a Github or provider-less user', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await mapGitHubProfile(db, { id: 42, login: 'jdoe' });

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { provider: 'GITHUB', provider_id: '42' },
            { login: 'jdoe', OR: [{ provider: null }, { provider: 'GITHUB' }] },
          ],
        },
      })
    );
  });

  it('links a pre-provisioned user that has no Github account row', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', login: 'jdoe', accounts: [] });

    const result = await mapGitHubProfile(db, { id: 42, login: 'jdoe' });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { provider: 'GITHUB', provider_id: '42', login: 'jdoe' },
    });
    expect(prisma.account.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { user_id: 'u1', provider_id: 'github', account_id: '42', username: 'jdoe' },
      })
    );
    expect(result).toEqual({ login: 'jdoe', provider: 'GITHUB', provider_id: '42' });
  });

  it('leaves an already-linked user alone', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', login: 'jdoe', accounts: [{ id: 'a1' }] });

    await mapGitHubProfile(db, { id: 42, login: 'jdoe' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.account.upsert).not.toHaveBeenCalled();
  });

  it('never blocks sign-in when linking fails', async () => {
    prisma.user.findFirst.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(mapGitHubProfile(db, { id: 42, login: 'jdoe' })).resolves.toEqual({
      login: 'jdoe',
      provider: 'GITHUB',
      provider_id: '42',
    });
  });
});

describe('mapGitLabProfile', () => {
  /**
   * findFirst answers two questions: "is this GitLab account already a user?"
   * (where.provider === 'GITLAB') and "does anyone hold this login?".
   */
  const users = ({
    own = null,
    taken = [],
  }: {
    own?: { id: string; login: string | null } | null;
    taken?: string[];
  }) =>
    prisma.user.findFirst.mockImplementation(
      async ({ where }: { where: { provider?: string; login?: { equals: string } } }) => {
        if (where.provider === 'GITLAB') return own;
        return where.login && taken.includes(where.login.equals) ? { id: 'someone' } : null;
      }
    );

  it('uses the GitLab username as login when nobody holds it', async () => {
    users({});

    await expect(mapGitLabProfile(db, { id: 7, username: 'jdoe' })).resolves.toEqual({
      login: 'jdoe',
      provider: 'GITLAB',
      provider_id: '7',
    });
  });

  it('takes the first free suffix when someone else holds the username', async () => {
    users({ taken: ['jdoe', 'jdoe-2'] });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBe('jdoe-3');
  });

  it('keeps the login a returning GitLab user already holds', async () => {
    users({ own: { id: 'u7', login: 'jdoe-2' }, taken: ['jdoe'] });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBe('jdoe-2');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('gives a returning GitLab user who has no login one', async () => {
    users({ own: { id: 'u7', login: null }, taken: ['jdoe'] });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBe('jdoe-2');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u7' },
      data: { login: 'jdoe-2' },
    });
  });

  it('scopes the id to a self-managed instance', async () => {
    users({});

    await expect(mapGitLabProfile(db, { id: 7, username: 'jdoe' }, 'inst-1')).resolves.toEqual({
      login: 'jdoe',
      provider: 'GITLAB',
      provider_id: 'inst-1:7',
    });
  });

  it("gives another instance's jdoe a different login", async () => {
    // gitlab.com's jdoe (id 7) holds "jdoe"; the school's jdoe (also id 7) is someone else.
    users({ taken: ['jdoe'] });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' }, 'inst-1');

    expect(result).toEqual({ login: 'jdoe-2', provider: 'GITLAB', provider_id: 'inst-1:7' });
  });

  it('never links an existing Github user', async () => {
    users({ taken: ['jdoe'] });

    await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(prisma.account.upsert).not.toHaveBeenCalled();
  });

  it('keeps the stored username of a returning account current', async () => {
    users({});

    await mapGitLabProfile(db, { id: 7, username: 'renamed' });

    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: { provider_id: 'gitlab', account_id: '7' },
      data: { username: 'renamed' },
    });
  });
});

describe('onAccountCreated', () => {
  it('stores the username the mapper saw on the new account row', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await mapGitLabProfile(db, { id: 8, username: 'gl-user' });

    await onAccountCreated(db, { id: 'acc1', providerId: 'gitlab', accountId: '8', userId: 'u1' });

    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      data: { username: 'gl-user' },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('makes a newly connected Github username the main login', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await mapGitHubProfile(db, { id: 42, login: 'gh-user' });
    prisma.user.findUnique.mockResolvedValue({ login: 'gl-user', provider: 'GITLAB' });
    prisma.user.findFirst.mockResolvedValue(null);

    await onAccountCreated(db, { id: 'acc2', providerId: 'github', accountId: '42', userId: 'u1' });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { login: 'gh-user', provider: 'GITHUB', provider_id: '42' },
    });
  });
});

describe('promoteGitHubLogin', () => {
  it('leaves the login alone when another user holds the Github username', async () => {
    prisma.user.findUnique.mockResolvedValue({ login: 'gl-user', provider: 'GITLAB' });
    prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

    await expect(promoteGitHubLogin(db, 'u1', '42', 'gh-user')).resolves.toBe('taken');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does nothing for a user already on their Github login', async () => {
    prisma.user.findUnique.mockResolvedValue({ login: 'gh-user', provider: 'GITHUB' });

    await expect(promoteGitHubLogin(db, 'u1', '42', 'gh-user')).resolves.toBe('unchanged');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
