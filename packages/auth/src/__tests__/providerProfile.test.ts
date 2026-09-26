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
  it('uses the GitLab username as login when nobody holds it', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(mapGitLabProfile(db, { id: 7, username: 'jdoe' })).resolves.toEqual({
      login: 'jdoe',
      provider: 'GITLAB',
      provider_id: '7',
    });
  });

  it('leaves login empty when another user holds the username', async () => {
    prisma.user.findFirst.mockResolvedValue({ provider: 'GITHUB', provider_id: '42' });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBeNull();
  });

  it('keeps the login for the returning GitLab user who holds it', async () => {
    prisma.user.findFirst.mockResolvedValue({ provider: 'GITLAB', provider_id: '7' });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBe('jdoe');
  });

  it('never links or writes to an existing user', async () => {
    prisma.user.findFirst.mockResolvedValue({ provider: null, provider_id: null });

    const result = await mapGitLabProfile(db, { id: 7, username: 'jdoe' });

    expect(result.login).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.account.upsert).not.toHaveBeenCalled();
  });

  it('keeps the stored username of a returning account current', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

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
